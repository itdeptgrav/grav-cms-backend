# Fit Assistant rules

**Lane B · product specification · revised 1 Oct 2026.**
Nine findings, in the words a sampling room uses, with no universal numbers.

**Revision note.** This version corrects the central error of the first draft:
findings 3.1–3.3 computed ease from the *draped* garment, which is close to
meaningless on a knit, and two of the three categories in scope are knit. Chest,
stomach and hem are now split by fabric behaviour (§4). It also adds the body
landmark contract (§3) the first draft assumed existed, and states which findings
are actually available in the first release (§3.4).

---

## 1. What the Fit Assistant is

It reads a finished drape and says, in plain words, what a pattern-maker would
say looking at a first sample on a stand.

It is **not** a grader, a corrector or a pass/fail stamp. It produces
**observations with evidence**. A person decides.

Three rules it never breaks:

1. **It never edits the pattern.** §7.
2. **It never says a number it cannot support.** A withheld finding is a correct
   outcome.
3. **It never calls a fit good merely because the cloth is touching the body.**
   On a knit that is what cloth does. §4.

---

## 2. Why there are no fixed thresholds

The archive's assistant held this:

```js
const RESIDUAL = { chest: 0.037, waist: 0.041, hem: 0.035, ... };
```

Those are not properties of garments. The file says what they are: residuals
measured on "Executive shirt M on its base body, 0.8″ mesh". Change the mesh
density and they are wrong. Change to a jersey tee and they are wrong by more
than they measure.

A number like "chest ease should be 2–3 inches" is wrong four ways at once: wrong
for a slim fit, wrong for an oversized tee, wrong for a knit, and wrong for a
different measuring method.

### How a rule set resolves

Every threshold comes from the most specific match of:

```
category  →  fit intent  →  fabric behaviour  →  size range
```

`polo / regular / knit-moderate-stretch / M–XL` beats `polo / regular / * / *`,
which beats `* / * / * / *`. If nothing matches at any level, the finding is
**withheld** — never computed against a borrowed number.

Rule sets are **data held by R&D**, versioned, with an author. A fitting records
which rule set version it used, because the same drape judged under a new rule
set is a different statement.

### The measurement method is part of the number

"Chest 104 cm" means nothing on its own. 104 measured where, around what, flat or
on the body, with the garment relaxed or smoothed?

Every finding stores its method: the **plane or landmark** it measured at, whether
it is a **flat-pattern** measurement or a **draped** one, whether it is a
circumference or a doubled flat width, and whether the cloth was relaxed or
under tension. Two numbers measured differently are never compared.

---

## 3. The body contract

Five of the nine findings need to know **where** on the body to measure. The
record has nowhere to put that: `avatarSchema.measurements` is
`Schema.Types.Mixed` with a `{}` default, and `poseRef` is a free string. Nothing
defines a chest plane, a shoulder point or a wrist.

This section is the contract for that, as **documentation**. It introduces no
application schema and asks for none in this release — it says what must exist
before the findings that depend on it can be honest.

### 3.1 Landmark fields

Every landmark carries:

| Field | Meaning |
|---|---|
| `name` | the identifier used by rules and findings |
| `physicalMeaning` | what it is on a real body, in a sentence a fitter would recognise |
| `locator` | a **plane** (height + normal) or a **point** in the body's coordinates |
| `source` | `stated`, `derived`, or `detected` |
| `confidence` | high / moderate / low |
| `confirmationRequired` | whether a person must agree before findings may use it |

`source` means: **stated** — a person or size chart gave it; **derived** —
computed from stated measurements by a documented rule; **detected** — found on
the body mesh by geometry. Detected landmarks on an unknown avatar are low
confidence and always require confirmation.

### 3.2 The landmarks, and what depends on each

| Landmark | Physical meaning | Locator | Realistic source | Findings that need it |
|---|---|---|---|---|
| `chest.plane` | fullest horizontal circumference of the chest | horizontal plane | stated height, or detected as the local maximum girth | chest (woven form) |
| `waist.plane` | the natural waist — narrowest girth between chest and hip | horizontal plane | detected; **genuinely ambiguous** on many bodies | stomach / waist |
| `hip.plane` | fullest girth below the waist | horizontal plane | stated or detected | hem |
| `shoulder.point` | outer end of the shoulder, where it turns into the arm | point, left and right | detected; the hardest of all — it is a judgement on a real fitting too | shoulder |
| `armhole.plane` | the plane through the armpit crease | plane per side | detected from the arm/torso junction | armhole |
| `bicep.plane` | fullest girth of the upper arm | plane per side | stated or detected | bicep |
| `neck.base` | the base of the neck circumference | closed curve | detected; varies with pose | collar / neck |
| `wrist.point` | the wrist bone | point per side | detected along the arm | sleeve length |
| `nape` | the bone at the base of the back neck | point | detected | garment length |

Two honest admissions in that table. `waist.plane` is ambiguous on bodies without
a defined waist, and a detected waist on such a body is a guess with a number
attached. `shoulder.point` is the single hardest landmark; two experienced fitters
disagree about it on a live model.

### 3.3 Landmarks the record cannot supply today

**None of these landmarks exist in the record.** `measurements` is an untyped
object; no plane, point or curve is defined anywhere in the schema, and no
detection runs on the avatar mesh.

### 3.4 What this means for the first release

| Available using body **measurements** only | Requires landmarks that do not exist |
|---|---|
| **collar / neck** — needs a stated neck girth | **stomach / waist** — needs `waist.plane` |
| **bicep** — needs a stated bicep girth | **hem** — needs `hip.plane` |
| **chest, knit form** — flat-pattern girth vs a stated chest girth (§4.2) | **shoulder** — needs `shoulder.point` |
| **garment length** — only where R&D states a target length | **armhole** — needs `armhole.plane` |
| | **sleeve length** — needs `shoulder.point` and `wrist.point` |
| | **chest, woven form** — needs `chest.plane` for the draped cross-section (§4.1) |

Four findings in the first release, five withheld. **The product must not claim
shoulder, armhole, sleeve-length or garment-length findings are available when
their landmarks do not exist**, and must not quietly substitute a plausible height
for a plane nobody defined.

A withheld finding says why:

> Shoulder is not reported for this fitting. It needs the shoulder point on the
> body, and this body does not define one.

### 3.5 What permits a high-confidence finding (M8)

A finding may be called high-confidence only when **all** of these hold:

1. a **published or cleanly derived sewing line** was used — not the cut boundary
   (`garment-template-contract.md` §4.12);
2. every seam it depends on has **confirmed alignment**;
3. the fabric profile is **measured**, not estimated, and is `grade: measured`
   (`fabric-profile-contract.md` §5);
4. the scale is **externally verified**, not merely self-consistent (M3, below);
5. the landmarks it depends on are high confidence and confirmed where required;
6. a **rule set matched at category and fabric level**, not at the fallback;
7. the drape **converged** — residual motion below the solver's own threshold.

Fail any one and the finding is still reported, but as **moderate** or **low**,
with the failed condition named. Fail a condition that biases the number itself —
1, 3 or 4 — and a dimensional finding is **withheld**, not downgraded.

### 3.6 Self-consistent scale is not verified scale (M3)

Two different statements, and the first draft ran them together:

- **Self-consistent** — the pattern's stated unit, its declared lengths and its
  built mesh all agree. This is what Lane A's fidelity gate checks, and it is
  satisfied by a pattern drawn at the wrong scale throughout.
- **Externally verified** — at least one length has been checked against
  something outside the file: a stated piece measurement, a known body
  dimension, a measured sample.

A fitting states which it has. A self-consistent-only fitting can still be
uniformly wrong by a factor, and only an external check rules that out.

---

## 4. Chest, stomach and hem — split by fabric behaviour

This is the correction at the heart of this revision.

**A knit stretches onto the body.** A jersey tee two sizes too small drapes to
*almost exactly the body's girth*, because that is what the body makes it do. Its
draped chest girth therefore tells you about the **body**, not about the pattern.
Reading ease from a draped knit cross-section reports "well fitted" for a garment
nobody can get into.

So the evidence differs by fabric, and the fabric profile — not the category —
decides which path is taken.

### 4.1 Woven path

Uses four things **together**, never one alone:

| Evidence | What it tells you |
|---|---|
| **Pattern dimensions** | the girth the garment is built to, measured on the sewing line, flat, doubled |
| **Draped dimensions** | the girth the cloth actually settles at, at the landmark plane |
| **Body dimensions** | the girth underneath |
| **Strain** | how hard the cloth is working — near zero on a well-fitted woven |
| **Clearance** | the gap between cloth and body around the plane |

A woven that is too tight shows itself twice: clearance goes to zero and strain
rises. A woven that is too loose shows as clearance with no strain. The pattern
girth anchors both.

**The limitation, stated on every woven girth finding:** a draped cross-section is
measured as a **convex** outline. Real cloth at the chest has folds and hollows
the convex hull crosses straight over, so a draped girth reads **larger** than a
tape would, and the error grows with looseness. It is useful for comparing one
fitting to another on the same body; it is not a tape measurement. Where woven
girth matters precisely, the pattern dimension is the trustworthy number.

### 4.2 Knit path

| Evidence | Role |
|---|---|
| **Flat-pattern girth vs body girth** | **primary.** Their difference is the negative ease — the number that actually describes the fit |
| **Strain** and **stretch response** | **primary simulation evidence.** How far into its stretch range the cloth is, and how hard it is pulling back |
| **Draped girth** | **cross-check only.** Confirms the solver settled; never the basis of the finding |

Negative ease is normal and intended on a knit. The rule set says how much is
right for that category and fit — a compression tee and a relaxed tee are both
correct at very different numbers.

**The rule this exists to enforce:** the Fit Assistant **never reports a good fit
merely because the stretched garment conforms to the body.** Conformance is
evidence the solver ran. It is not evidence the garment fits.

### 4.3 When neither path is available

Both paths are withheld, with the reason, when:

- the **fabric profile is too uncertain to classify** as woven or knit — not a
  default to woven, because that reverses the primary evidence;
- the sewing line could not be constructed, so the flat-pattern girth is biased
  (`garment-template-contract.md` §4.12 step 4);
- the landmark plane does not exist (§3.4) — woven path only;
- the body girth was never stated — knit path only, since it is the primary term.

> Chest is not reported for this fitting. The fabric profile does not say whether
> this cloth stretches, and the two kinds of cloth are judged on different
> evidence.

### 4.4 Stomach / waist

Same split. Woven: clearance and strain at `waist.plane`, with the pattern girth.
Knit: flat-pattern vs body girth at the waist.

Additionally, and for both: a waist finding is withheld where the body has no
defined waist, rather than reported against a detected plane the body does not
really have (§3.2).

### 4.5 Hem

Same split again, at `hip.plane` where the garment reaches it.

The finding a hem actually needs is often not girth but **whether the hem rides
up or flares** — visible as the hem's own circumference against the body below it
and the hem line's deviation from level. Both are shape observations and are
reported as observations, available even where girth is withheld.

---

## 5. The remaining six findings

Each states its evidence, what it cannot see, and when it is withheld. None of
them invents a number.

### 5.1 Shoulder

**Needs** `shoulder.point`, both sides. **Not available in the first release**
(§3.4).

When available: the seam's position relative to the shoulder point, each side
independently, as a signed distance — inboard, on, or overhanging. Plus whether
the cloth is pulling across the shoulder.

Cannot see: shoulder slope against this particular body's slope, which is a large
part of why a shoulder looks wrong.

### 5.2 Armhole

**Needs** `armhole.plane`. **Not available in the first release.**

When available: clearance between the underarm point and the armpit, and strain
around the armhole under the sleeve.

Cannot see: comfort through a range of movement. Everything here is one static
pose, and an armhole that is fine standing still can bind completely when the arm
lifts. Said plainly on the finding, never implied away.

### 5.3 Bicep

**Available** — needs a stated bicep girth.

Woven: clearance and strain at the widest point of the upper arm. Knit:
flat-pattern sleeve girth against the stated bicep girth.

### 5.4 Collar / neck

**Available** — needs a stated neck girth.

The neck opening's finished length against the neck girth. On a knit band, the
negative ease is the point: a band shorter than the neck is correct, and the rule
set says by how much for that category.

Cannot see: the collar's roll and stand (`garment-template-contract.md` §7).
A polo collar is simulated lying flat, so nothing here is a statement about how
it will stand up.

### 5.5 Sleeve length

**Needs** `shoulder.point` and `wrist.point`. **Not available in the first
release.**

When available: along the sleeve's own surface from shoulder point to hem, against
the arm length, in one stated pose.

Cannot see: how much length the arm takes back when it bends.

### 5.6 Garment length

**Available only where R&D states a target length**, measured the same way.

From `nape` down the back's surface to the hem — so the landmark is needed for the
body-relative form. Where R&D states a target centre-back length, the pattern's
own length is compared to it with no landmark at all, which is the available form.

Cannot see: where a hem sits relative to a wearer's own proportions without the
landmark.

---

## 6. Writing the messages

The audience is a sampling room, not an engineer.

| Instead of | Write |
|---|---|
| "Chest residual 0.041 exceeds tolerance" | "The chest is tighter than a regular polo usually is." |
| "Strain tensor magnitude 0.18 at armhole" | "The cloth is pulling under the arm." |
| "Convex hull girth 1042 mm" | "Measured around the chest at its fullest: 104 cm." |

Rules:

- **Name the place, say what is happening, give the number second.**
- **Never give an instruction.** "The chest is tight" — not "add 2 cm to the
  front."
- **Say when you do not know**, in the same voice as everything else.
- **One finding, one sentence.** Detail goes behind it.
- **Units as R&D works in them**, both if asked for.

And three sentences that are wrong however they are phrased:

- anything asserting a measurement when a dimensional finding is withheld;
- anything calling a knit fit good on conformance alone (§4.2);
- anything implying the software changed, or should change, the pattern (§7).

---

## 7. Why the software must never edit the pattern

The 2D pattern is the only thing the factory cuts. A fitting is **evidence about**
it.

If the Fit Assistant could nudge a seam to make a finding go green, the pattern in
the system would stop being the pattern that was approved, and the drape would
stop being evidence about anything — it would be a drawing of its own conclusion.

So: findings and evidence out, no geometry in. A person reads the fitting, decides
what to change, changes it in the pattern, and the previous fitting goes **stale**
rather than following the change.

That is also why a stale fitting is never silently re-pointed at a new revision
(R11 in the contract). A fitting is a statement about one specific revision, and
it expires with it.
