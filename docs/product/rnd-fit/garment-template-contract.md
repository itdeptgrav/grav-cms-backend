# Garment template and seam-mapping contract

**Lane B · product specification · 1 Oct 2026.**
Scope: the first three categories — basic T-shirt, polo shirt, basic woven
shirt — and the name-free contract that lets a template describe any of them.

> **Read this first.** Nothing in this document is code and nothing in it
> instructs anybody to change a pattern. It says what a fitting needs to be
> given before it can be attempted, where each of those things comes from, and
> which of them only a person can supply.

---

## 1. Why this contract exists in this shape

The CAD archive already contained a working assembler. It was discarded, and
the reason is the whole argument for what follows.

It looked for drawing groups called `"Chest"`, `"Bottom hem"` and `"Coller"` —
including that misspelling, because one dataset spelled it that way. It decided
which outline was the yoke by looking at a group named `__custom__yokeseam`.
Its fit thresholds were measured on *one* garment: "Executive shirt M on its
base body". It worked, on that shirt, in that drawing, from that shop.

A second shop sends a DXF whose pieces are called `Pattern_636968`. Every
lookup returns nothing and the assembler reports that the drawing contains no
garment. The drawing is fine. The assumption was not.

So this contract is built on three rules:

| Rule | What it means in practice |
|---|---|
| **A role is assigned, never recognised** | No part of the system searches a drawing for a word. A piece has a role because somebody gave it one, or because a suggestion was confirmed. |
| **A seam is geometry, not a name** | A seam is two ordered runs of outline with a direction and an alignment. It would be the same seam if every piece were called `A`, `B`, `C`. |
| **Absent is stated, never assumed** | An edge that is not sewn says so. A missing grainline is a missing grainline, not a vertical one. |

---

## 2. What the drawing already gives us, and what it never will

This matters more than any other table here, because it decides how much work a
person has to do per pattern.

Our parser reads an AAMA/ASTM DXF and produces, per piece: outline, closed
flag, internal lines, notches, drill points, turn points, curve points, grade
points, grainline, mirror line, seam allowance, cut-on-fold, mirrored, size,
quantity, material, component class, width, height, area, perimeter.

**The genuine CLO export this house actually produces publishes five of those
layers and not the others:**

| AAMA layer | Meaning | In our real export |
|---|---|---|
| 1 | piece boundary | ✅ present |
| 2 | turn points | ✅ present |
| 3 | curve points | ✅ present |
| 7 | grainline | ✅ present |
| 8 | internal construction lines | ✅ present |
| 4 | **notches** | ❌ absent |
| 5 | grade points | ❌ absent |
| 6 | **mirror / fold line** | ❌ absent |
| 13 | drill holes | ❌ absent |
| 14 | **sew line** | ❌ absent |

Three of the absent four are the ones a seam-matcher would most want.

- **No notches** means seam pairing cannot be derived from registration marks.
  There is nothing in the file that says "this point on the armhole meets that
  point on the cap".
- **No sew line** means the seam allowance is unpublished. Not zero —
  *unpublished*. The outline is a single line and the file does not say whether
  it is the cut line or the stitching line.
- **No mirror line** means cut-on-fold is unstated, and our parse records it as
  `null` rather than `false`.

And the pieces in that export are named `Pattern_636968`, `Pattern_636969`,
`Pattern_1621764`, `Pattern_1621765`, `Pattern_2091816` — identifiers CLO
counted out, not names anybody chose.

**Conclusion.** For the patterns this house has today, role assignment and seam
pairing are human work. A template can make that work short and checkable. It
cannot make it automatic, and a product that claimed otherwise would be wrong
about the files it is actually given.

---

## 3. Three ways to know something, and they are not interchangeable

Every field in every table below carries one of these.

| Source | Meaning | Trust |
|---|---|---|
| **Derived** | Computed from the drawing's own geometry. Re-computable, identical every time. | Use directly |
| **Stated** | A person or an upstream record said it. Attributable. | Use, and show who said it |
| **Confirmed** | The system proposed it and a person agreed. Carries the proposal's method. | Use, and show the basis |

A fourth state exists and is the important one: **unknown**. An unknown value is
never replaced by a plausible default anywhere in this product.

---

## 4. The generic seam-mapping contract

This is the part that must survive every garment category. It describes a
garment with no garment words in it.

### 4.1 Piece

| Field | Source | Notes |
|---|---|---|
| `pieceRef` | Derived | Already minted per piece, stable across re-parses of the same file |
| `role` | Stated / Confirmed | A value from the **template's own role vocabulary** (§5). Never read from the piece's name |
| `cutQuantity` | Stated, or Derived where the drawing publishes it | How many of this piece the garment contains, after any unfolding |
| `symmetry` | Stated / Confirmed | One of `single`, `mirrored-pair`, `identical-pair`, `cut-on-fold` (§4.6) |
| `layer` | Stated | `shell`, `lining`, `interlining`, `rib`, `trim`, `pocketing` |
| `grain` | Derived where layer 7 exists, else Stated | Direction and angle off the piece's vertical (§4.8) |
| `simulated` | Derived from `layer` + template | Whether this piece takes part in the drape at all (§7) |

A piece whose `role` is unset is not an error. It is a piece nobody has placed
yet, and the readiness report names it.

### 4.2 Edge

An **edge** is a run along one piece's closed outline. It is not a line, not a
segment list, and not a name.

| Field | Source | Notes |
|---|---|---|
| `edgeId` | Assigned | Unique within the piece. Opaque — nothing parses it |
| `from`, `to` | Confirmed | Two **anchors** on the outline (§4.3) |
| `direction` | Derived from `from`→`to` | Which way along the outline the run travels |
| `length` | Derived | Arc length between the anchors, in the pattern's own unit |
| `role` | Stated / Confirmed | What this edge is for, from the template's edge vocabulary |

**Ordered edge geometry.** The run is always stored with its points in travel
order, from `from` to `to`. Everything downstream — pairing, easing, sampling —
depends on that order being the stated one and not the outline's storage order.

### 4.3 Anchors — how an edge knows where it starts

In order of preference, because they differ in how well they survive a pattern
edit:

| Anchor kind | Survives a re-parse | Survives a pattern edit | Available in our files |
|---|---|---|---|
| **Notch** | Yes | Usually | ❌ not in our current exports |
| **Turn point** (a corner on the outline) | Yes | Often | ✅ present |
| **Placed point** (a person clicked it) | Yes | Needs re-confirming | Always available |
| **Arc-length fraction** | Yes | **No** | Always available |

Arc-length fractions are the fallback and they are the reason a fitting goes
stale: move one point on an outline and every fraction after it means something
different. A template should prefer turn points, and the system should say which
anchor kind each edge used, because that is what tells a reader how much a
pattern edit is likely to have broken.

### 4.4 Seam

A seam joins **two ordered sequences of edges**. Not two edges — two sequences.

This is not generality for its own sake. On every garment in scope, the armhole
is one sleeve-cap edge sewn to *two or three* body edges in order. A contract
that paired one edge to one edge could not express a set-in sleeve.

| Field | Source | Notes |
|---|---|---|
| `seamId` | Assigned | Opaque |
| `sideA`, `sideB` | Confirmed | Ordered lists of `{pieceRef, edgeId}` |
| `alignment` | Confirmed | Which end of A meets which end of B (§4.5) |
| `ease` | Derived, reviewed | The length difference, as a percentage of the shorter side (§4.7) |
| `easeDistribution` | Stated | `even`, or concentrated between two named anchors |
| `seamType` | Stated | §4.9 |
| `order` | Stated | Where this seam falls in the assembly sequence (§6) |
| `confidence` | System | `proposed`, `confirmed`, `rejected` |
| `confirmedBy`, `confirmedAt` | System | A confirmation nobody is attributable for is a guess |

**Pairing rule.** Both sides are walked by normalised position along their own
total length. Position `0.5` on side A is sewn to position `0.5` on side B,
whatever the point counts are on either side. This is what makes a 125-point
armhole sewable to a 40-point cap.

### 4.5 Start/end alignment, and why reversal is a real failure

A seam has two possible alignments: A-start to B-start, or A-start to B-end.
Choosing the wrong one does not fail. It produces a garment with a sleeve sewn
in backwards, which drapes, renders, and looks almost right.

So alignment is **explicit**, never inferred from which way the outline happened
to be stored, and the validation pack contains a reversed-seam case
(`VM-10`) whose expected outcome is a refusal, not a warning.

### 4.6 Fold and symmetry

| Value | What the drawing contains | What assembly does |
|---|---|---|
| `single` | the whole piece | use as drawn |
| `mirrored-pair` | one piece, cut twice mirrored | make a mirrored twin; both are sewn |
| `identical-pair` | one piece, cut twice the same way | make an identical twin |
| `cut-on-fold` | **half** the piece | reflect across the fold edge into one whole piece — **and create no seam at the fold** |

The last row is the one that goes wrong. A half-back that is not unfolded gives
a garment half the width; a half-back that is unfolded *and* given a centre seam
gives a garment with a seam down the back that the pattern never had. Our
exports do not publish a mirror line, so `cut-on-fold` is **stated by a person**
on every pattern this house currently produces.

### 4.7 Easing and gathering

Two edges sewn together are rarely the same length. The difference is
deliberate: a sleeve cap is longer than its armhole so the cap sits round the
shoulder.

`ease` is recorded as a percentage of the shorter side, and whether it is
acceptable depends on the seam, the category and the fabric — see
`fit-assistant-rules.md` §2. The contract's job is only to record it, its
distribution, and the fact that somebody looked at it.

A seam whose two sides differ by more than the template allows is a
**seam-length mismatch**, which is a readiness failure, not a warning
(`VM-11`).

### 4.8 Grain

Direction and angle off vertical, derived from AAMA layer 7 where present.

**This is not paperwork.** The solver blends a fabric's lengthwise and
crosswise behaviour by each thread's angle to the grain. A piece with no grain
has no defensible answer for which way it stretches, so a fitting run without it
is reporting a fabric nobody specified. The readiness rule is in
`validation-matrix.md` `VM-16`.

### 4.9 Seam type

`plain`, `flat-felled`, `french`, `overlocked`, `bound`, `topstitched`,
`taped`.

Recorded now, used later: a flat-felled seam is four layers of cloth and
behaves stiffer than the panels either side of it. The first templates may treat
every seam the same; the field exists so that when they stop doing so, nobody
has to go back and ask what the seams were.

### 4.10 Edges that are not sewn

Every edge of every piece must end up in exactly one of three states:

1. part of a seam;
2. **declared unsewn**, with a reason (`hem`, `opening`, `vent`, `placket-fold`,
   `finished-edge`, `facing-turn`);
3. not yet decided — which is a readiness failure and is named as such.

The second state is the point. A hem is not a gap in the mapping; it is a fact
about the garment. A system that cannot tell "nobody has done this yet" from
"this is finished and free" will either nag about hems for ever or quietly
accept a missing side seam.

### 4.11 Construction notes

Free text against a seam or a piece, for the half of any instruction that does
not fit a field. Never parsed, never used to decide anything.

---

## 5. Role vocabularies are per template, not global

A role is meaningful only inside a category. "Band" means a neck band on a
T-shirt and a cuff band on a polo sleeve, and a single global list would have to
invent a distinction nobody in a sampling room makes.

So each template declares its own vocabulary, and the assembler only ever
compares a piece's role against the roles that template declared. The solver
below it does not know any of these words.

---

## 6. The three categories

For each: required pieces, optional pieces, what each piece is for, cut
quantity, symmetry, grain, the edges that must be sewn, the order they are sewn
in, which edges are legitimately unsewn, and what is not yet simulated.

> **Cut quantity** below is the count in the finished garment, after unfolding
> and mirroring — not the number of outlines in the DXF.

### 6.1 Basic T-shirt

**Required pieces**

| Role | What it is for | Cut qty | Symmetry | Grain |
|---|---|---|---|---|
| `body.front` | the front of the torso | 1 | `cut-on-fold` or `single` | lengthwise, required |
| `body.back` | the back of the torso | 1 | `cut-on-fold` or `single` | lengthwise, required |
| `sleeve` | covers the upper arm | 2 | `mirrored-pair` | lengthwise, required |
| `neck.band` | finishes the neck opening | 1 | `single` | **crosswise** — a neck band is cut across the grain so it stretches round the neck |

**Optional pieces**

| Role | When it appears | Cut qty | Simulated? |
|---|---|---|---|
| `pocket.patch` | a chest pocket | 1 | Yes, as a surface layer |
| `reinforcement.shoulder` | shoulder tape | 2 | **No** (§7) |
| `label.*` | woven or printed labels | — | **No** |

**Required sewing edges and pairing order**

| # | Seam | Side A | Side B | Typical ease |
|---|---|---|---|---|
| 1 | shoulder | `body.front` shoulder, each side | `body.back` shoulder, same side | 0 – 2 % onto the back |
| 2 | neckline | `neck.band` join edge | `body.front` neck + `body.back` neck, in order round the opening | band is **shorter**: it is stretched on, typically 10 – 25 % |
| 3 | sleeve to armhole | `sleeve` cap | `body.front` armhole + `body.back` armhole, in order | 0 – 5 % |
| 4 | side and underarm | `body.front` side + `sleeve` underarm | `body.back` side + `sleeve` underarm | 0 % |

Seam 4 is one continuous seam on a T-shirt, from cuff to hem, which is why the
contract's sides are sequences. Sewing it as two separate seams is also valid
construction and the template must accept both.

**Legitimately unsewn:** bottom hem, sleeve hem, the band's outer fold.

**Not simulated yet:** the band's fold-back (modelled as a single layer),
shoulder tape, labels, hem turn-ups.

### 6.2 Polo shirt

A polo is a T-shirt with a neck opening, a placket and a flat collar.

**Required pieces:** everything in §6.1 except `neck.band`, plus:

| Role | What it is for | Cut qty | Symmetry | Grain |
|---|---|---|---|---|
| `collar.flat` | the fold-over collar | 1 | `single` | crosswise or lengthwise — **stated**, it varies by house |
| `placket.top` | the overlapping side of the opening | 1 | `single` | lengthwise |
| `placket.under` | the underlapping side | 1 | `single` | lengthwise |

**Optional:** `cuff.band` (banded sleeve), `pocket.patch`, `reinforcement.*`,
`interlining.collar`.

**Required sewing edges and pairing order**

| # | Seam | Side A | Side B | Notes |
|---|---|---|---|---|
| 1 | shoulder | `body.front` shoulder | `body.back` shoulder | as §6.1 |
| 2 | placket to opening | `placket.top` / `placket.under` join edges | the front opening edges | **order matters**: the plackets are attached before the collar |
| 3 | collar to neckline | `collar.flat` join edge | front neck + back neck + the placket top edges | the collar ends land on the placket, not on the raw neckline |
| 4 | sleeve to armhole | `sleeve` cap | front + back armhole | |
| 5 | side and underarm | front side + sleeve underarm | back side + sleeve underarm | |
| 6 | cuff band | `cuff.band` join edge | `sleeve` lower edge | only when banded |

**Legitimately unsewn:** hem, sleeve hem (unbanded), collar outer edge, placket
free edges below the opening.

**Not simulated yet:** collar interlining stiffness, the placket's layered
thickness, buttons and buttonholes, the collar's roll line.

> The collar's roll — how it stands and falls — is the single most visible
> thing a polo does that is not yet modelled. The fitting shows a collar lying
> flat. It must not be read as a statement about how the collar will stand.

### 6.3 Basic woven shirt

Same family, more pieces, and no stretch to hide anything.

**Required pieces**

| Role | What it is for | Cut qty | Symmetry | Grain |
|---|---|---|---|---|
| `body.front` | front torso, usually two halves | 2 | `mirrored-pair` | lengthwise |
| `body.back` | back torso | 1 | `cut-on-fold` or `single` | lengthwise |
| `sleeve` | upper arm to wrist | 2 | `mirrored-pair` | lengthwise |
| `collar.stand` | the band that sits against the neck | 1 | `single` | stated |
| `collar.fall` | the part that folds over | 1 | `single` | stated |
| `cuff` | finishes the sleeve | 2 | `identical-pair` | stated |

**Optional pieces**

| Role | When it appears | Notes |
|---|---|---|
| `panel.upper-back` | a transverse panel across the shoulders | when present it **replaces** the back's shoulder edges |
| `placket.front` | a separate front band | often cut as part of `body.front` instead |
| `pocket.patch` | chest pocket | |
| `sleeve.opening` | the slit facing at the cuff | |
| `interlining.*` | collar, cuff, placket | **not simulated** |

**Required sewing edges and pairing order**

| # | Seam | Side A | Side B | Notes |
|---|---|---|---|---|
| 1 | upper-back panel to back | panel lower edge | `body.back` upper edge | **only if the panel exists.** If it does not, the back's own shoulder edge is used in seam 2 |
| 2 | shoulder | `body.front` shoulder ×2 | panel shoulder, or `body.back` shoulder | |
| 3 | sleeve opening | facing edges | the sleeve slit | before the cuff |
| 4 | sleeve to armhole | `sleeve` cap | front armhole + (panel armhole) + back armhole, in order | the body side is **two or three runs** |
| 5 | side and underarm | front side + sleeve underarm | back side + sleeve underarm | |
| 6 | cuff | `cuff` join edge | `sleeve` lower edge | usually gathered or pleated: ease is deliberate and can be large |
| 7 | collar stand to neckline | stand join edge | front neck + (panel neck) + back neck | |
| 8 | collar fall to stand | fall join edge | stand upper edge | |

**The conditional piece is the point.** Whether the shirt has an upper-back
panel changes which edges exist and which seams are required. A template that
required it would reject half the shirts in the world; one that ignored it would
mis-sew the other half. The contract handles it with a rule of the form *"when
this role is present, these seams become required"*.

**Legitimately unsewn:** bottom hem, cuff outer edges, collar fall outer edge,
front placket fold, side vents.

**Not simulated yet:** interlining, buttons and buttonholes, pleats at the cuff
and back, the collar roll, topstitching, and the thickness of a flat-felled
seam.

---

## 7. What is not simulated, and how that is said

Three different things get confused here, and they need different words on
screen.

| Kind | Example | What the product says |
|---|---|---|
| **Not modelled** | collar roll, interlining stiffness, buttons | "This fitting does not model the collar's roll. Judge the stand from the sample." |
| **Modelled simply** | a folded band drawn as one layer | "The neck band is shown as a single layer, so it will look thinner than the made garment." |
| **Excluded on purpose** | labels, shoulder tape | nothing on screen; they are not garment shape |

The first two must appear beside the fitting, not in a document. A person
looking at a flat-lying polo collar will otherwise conclude the pattern is
wrong.

---

## 8. Readiness failures and safe warnings

A **readiness failure** stops a fitting. A **warning** lets it run and travels
with the result.

The principle: *a fitting that cannot be trusted must not be produced*, because
a believable picture with the wrong dimensions is worse than no picture —
somebody will approve a sample against it.

### Readiness failures — the fitting does not run

| # | Condition | Why it stops |
|---|---|---|
| R1 | No piece has a usable closed outline | there is nothing to sew |
| R2 | The pattern states no unit | every length is meaningless; out by 25.4× if guessed wrong |
| R3 | A required role for the chosen template is unassigned | the garment is incomplete by that template's own definition |
| R4 | An edge is neither sewn nor declared unsewn | nobody has finished the mapping |
| R5 | A seam's two sides differ by more than the template's ease allowance | the pieces as mapped do not fit each other |
| R6 | A piece's outline is open or self-intersecting | it cannot be turned into cloth |
| R7 | No fabric profile for a simulated piece | the drape would be of a fabric nobody specified |
| R8 | A piece has no grain, and its fabric behaves differently along and across | the stretch direction is undefined |
| R9 | The pattern revision changed after the mapping was confirmed | the mapping may point at geometry that moved |

### Safe warnings — the fitting runs and says this

| # | Condition | What travels with the result |
|---|---|---|
| W1 | Seam allowance unpublished | "Sewing lines were taken as the cut lines, so the garment will read slightly larger than it is." |
| W2 | Ease on a seam is unusual but inside the allowance | named, with the number |
| W3 | An optional piece is absent | "This shirt has no separate upper-back panel." |
| W4 | Fabric values are estimated rather than measured | the whole fitting is marked estimated |
| W5 | A piece's role was confirmed from a suggestion rather than stated | the basis is shown |
| W6 | Anchors are arc-length fractions rather than turn points or notches | "This mapping will need re-checking after any pattern edit." |
| W7 | A construction element in §7 is present in the garment | the sentence from §7 |

---

## 9. What R&D must provide, per pattern

Short on purpose. Everything else is derived or defaulted to unknown.

1. **The template** — which of the three categories this is.
2. **A role for each piece** that takes part in the garment.
3. **Cut quantity and symmetry** for each — in particular, which pieces are cut
   on the fold, because our exports do not publish a mirror line.
4. **The seam mapping** — edge to edge, with alignment.
5. **Which edges are finished rather than sewn.**
6. **A fabric profile** per piece or per garment (`fabric-profile-contract.md`).
7. **The body** the garment is being fitted to.
8. **The unit**, if the DXF does not state one — or a re-export that does.

### Derivable without a person

Outline, closed flag, perimeter, area, width, height, turn points, curve points,
internal lines, grainline **where layer 7 exists**, notches **where layer 4
exists**, seam allowance **where layer 14 exists**, size, and the unit **where
the file states one**.

### Must be confirmed by a person, always

Role. Symmetry and cut-on-fold. Seam pairing and alignment. Which edges are
finished. Which fabric belongs to which piece. Anything the file did not
publish.

---

## 10. What this contract deliberately does not do

- It does not name a piece. Roles are assigned.
- It does not guess a seam from proximity, shape or length similarity. Two
  edges being the same length is not evidence they are sewn together; on a
  shirt, several pairs are the same length and only one pairing is correct.
- It does not edit a pattern, ever. See `fit-assistant-rules.md` §5.
- It does not define a universal number anywhere. Every tolerance in this
  document is "the template's", and the templates set them by category, fit and
  fabric — `fit-assistant-rules.md` §2.
