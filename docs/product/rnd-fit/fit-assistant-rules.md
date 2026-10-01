# Fit Assistant — what it reports, and how it decides

**Lane B · product specification · 1 Oct 2026.**
Nine findings, in plain language, with no universal numbers anywhere.

---

## 1. What the Fit Assistant is

After a fitting runs, somebody has to look at it and decide whether the pattern
is right. The Fit Assistant is the list of things worth looking at, each with
the numbers behind it and a suggestion of what to check.

**It is not a grader, a corrector or an approver.** It reports; a designer
decides. §5 explains why that boundary is absolute.

Every finding has one of three states, and the words matter:

| State | On screen | Meaning |
|---|---|---|
| **Normal** | plain text, no colour | nothing here needs attention |
| **Worth a look** | amber | a designer should check this; it may well be intended |
| **Needs attention** | red | this would be a problem on a real garment |

Deliberately not "pass / fail". A fitting is evidence, and most of what it finds
is a judgement a person makes — a relaxed fit and a too-big garment produce the
same measurement and are not the same thing.

---

## 2. Why there are no fixed thresholds

The archive's assistant said a chest with less than 2.0″ of ease was too tight.
That number came from one garment: an Executive shirt, size M, woven poplin, on
its own base body.

Apply it elsewhere and it is wrong in both directions. A knit T-shirt is
*meant* to measure less than the chest it goes on — negative ease is the design.
A relaxed woven overshirt with 2″ of ease is tight, not comfortable.

So the Assistant has no thresholds of its own. It asks the **rule set** in
force, and a rule set is selected by five things:

| Varies by | Effect |
|---|---|
| **Category** | a T-shirt, a polo and a woven shirt want different amounts of room in the same place |
| **Intended fit** | `slim`, `regular`, `relaxed` — stated by R&D per style, never guessed from the numbers |
| **Woven or knit** | decides whether negative ease is correct or impossible |
| **Stretch percentage** | how much of the needed room the cloth can supply itself |
| **Customer specification** | a buyer's own size chart or tolerance **overrides everything below it** |
| **Measurement method** | half-chest flat vs full girth; over or under the arm; relaxed or extended |

### How a rule set resolves

1. Start from the **category + intended fit** band.
2. Adjust for **fabric**: on a knit, shift the acceptable band down by roughly
   the amount the cloth can give; on a woven, do not.
3. Apply the **customer's specification** where one exists — it replaces, not
   nudges.
4. Record which rule set was used **on the finding**, so two people reading the
   same fitting next month can see why it said what it said.

A rule set with no entry for the garment in hand produces findings of
confidence `low` that say *"no agreed range for this combination"* rather than
borrowing a number from a different garment.

### The measurement method is part of the number

A chest measured flat across a folded garment and doubled is not the same
quantity as a girth measured round a draped one, and comparing them silently is
a 1–2″ error with no symptom. Every finding states the method it used, and
refuses to compare two measurements taken by different methods.

---

## 3. The nine findings

The shape is the same for each: what it needs, what it does, what happens when
it cannot, what it says, how sure it is, what it points at, and what to check.

> **Confidence** is capped by the weakest input. An estimated fabric or an
> unverified scale caps every finding at `low`, however clean the geometry.

---

### 3.1 Chest

| | |
|---|---|
| **Needs** | body chest girth; the draped garment's girth at chest height; the rule set; fabric category and stretch |
| **Calculation** | garment girth − body girth = ease. Compared against the rule set's band for this category, fit and fabric |
| **If unavailable** | no body chest, or the chest height cannot be located on the body → *"Chest was not assessed: this fitting has no body chest measurement."* Never a silent omission |
| **Normal** | "Chest — room to move: 8 cm over the body. Normal for a regular-fit woven shirt." |
| **Worth a look** | "Chest — close. 3 cm over the body, where this fit usually has 6–12 cm. May be intended for a slim cut." |
| **Needs attention** | "Chest — too tight. The garment measures 2 cm less than the body, and this cloth does not stretch." |
| **Confidence** | high when the fabric is measured and the scale verified; low when either is estimated |
| **Points at** | the front and back body panels, and their side edges |
| **Suggested check** | "Check how the chest width is shared between front and back, and whether the side seam sits where you intend." |

---

### 3.2 Stomach / waist

| | |
|---|---|
| **Needs** | body waist girth; garment girth at waist height; where the waist sits on this body; rule set |
| **Calculation** | as chest, at waist height. On a shirt worn loose, also compared against the chest reading — a garment narrower at the waist than the chest is shaped, and that is a design choice to report, not a fault |
| **If unavailable** | no body waist, or the body has no identifiable waist height → say so and assess chest and hem instead |
| **Normal** | "Stomach — comfortable: 10 cm over the body." |
| **Worth a look** | "Stomach — close over the stomach, 2 cm. The fabric is pulling slightly here." |
| **Needs attention** | "Stomach — too tight. The garment will not close comfortably over this body." |
| **Confidence** | one step lower than chest by default: the waist position on a body is less well defined than the chest |
| **Points at** | front and back panels, side edges, any waist shaping |
| **Suggested check** | "Check the side seam shape between chest and hem, and whether this body's stomach is larger than the block assumes." |

---

### 3.3 Hem

| | |
|---|---|
| **Needs** | garment girth at the hem; body girth at the same height; rule set |
| **Calculation** | ease at the hem, plus whether the hem is wider or narrower than the chest |
| **If unavailable** | the hem falls below the body model → *"The garment is longer than the body model, so the hem was not assessed."* This is common and is not a fault |
| **Normal** | "Hem — hangs clear of the body." |
| **Worth a look** | "Hem — narrow. The hem is tighter than the chest, so the shirt will ride up when worn out." |
| **Needs attention** | "Hem — will not sit over the hips." |
| **Confidence** | medium; hem behaviour depends on whether it is worn tucked, which the fitting does not know |
| **Points at** | lower edges of front and back panels |
| **Suggested check** | "Decide whether this is worn tucked. A tucked shirt tolerates a narrower hem." |

---

### 3.4 Shoulder

| | |
|---|---|
| **Needs** | body shoulder point positions; where the shoulder seam ends on the draped garment; intended fit |
| **Calculation** | distance from the seam end to the body's shoulder point, along the body's width |
| **If unavailable** | the body has no shoulder landmarks → say so; do not substitute the armhole |
| **Normal** | "Shoulder — the seam sits on the shoulder point." |
| **Worth a look** | "Shoulder — the seam falls 3 cm past the shoulder point. Correct for a dropped shoulder; check this is intended." |
| **Needs attention** | "Shoulder — narrow. The seam pulls 2 cm inside the shoulder point and the fabric is strained across the back." |
| **Confidence** | high — this is a position, not a girth, and positions are the most reliable thing a drape produces |
| **Points at** | the shoulder edges of the front panel and of the back or upper-back panel |
| **Suggested check** | "Check the shoulder width against the armhole depth — they move together." |

---

### 3.5 Armhole

| | |
|---|---|
| **Needs** | the armhole seam; clearance between cloth and body at the arm root; strain around the seam |
| **Calculation** | minimum clearance at the arm root, and how much the fabric around the seam is stretched relative to the same fabric at rest |
| **If unavailable** | no sleeve in the garment, or the arm root cannot be located → report "not assessed" |
| **Normal** | "Armhole — no pulling at the arm root." |
| **Worth a look** | "Armhole — pulling. The fabric is tight where the sleeve meets the body." |
| **Needs attention** | "Armhole — the garment is pressed into the arm root and will restrict the arm." |
| **Confidence** | medium — an armhole's comfort also depends on how the arm moves, and the fitting is a static pose |
| **Points at** | the armhole edges on every body piece, and the sleeve cap |
| **Suggested check** | "Armhole depth, sleeve cap height and sleeve width work together — check all three rather than one." |

---

### 3.6 Bicep

| | |
|---|---|
| **Needs** | body upper-arm girth; garment girth round the upper arm; rule set; fabric stretch |
| **Calculation** | ease round the upper arm |
| **If unavailable** | no sleeve, or no body upper-arm measurement → "not assessed" |
| **Normal** | "Sleeve width — comfortable round the upper arm." |
| **Worth a look** | "Sleeve width — close. 2 cm round the upper arm; a woven sleeve usually wants more." |
| **Needs attention** | "Sleeve width — too tight round the upper arm." |
| **Confidence** | high where the body has a measured upper arm; low where it is inferred |
| **Points at** | the sleeve, at its widest |
| **Suggested check** | "Widening the sleeve lengthens the cap seam — re-check it against the armhole." |

---

### 3.7 Collar / neck

| | |
|---|---|
| **Needs** | body neck girth; the finished length of the neck edge that goes round the neck; the neckline it is sewn to; fabric category |
| **Calculation** | neck edge length − body neck girth. **On a knit band, this is expected to be negative** — the band is cut short and stretched on, and the finding is about whether it is short by the right amount |
| **If unavailable** | no neck finish, or no body neck measurement → "not assessed" |
| **Normal** | woven: "Collar — sits comfortably, 2 cm of room." · knit: "Neck band — cut 15 % shorter than the opening, which is normal for this fabric." |
| **Worth a look** | "Collar — close. A buttoned collar usually wants a little more room than this." |
| **Needs attention** | woven: "Collar — will not fasten on this neck." · knit: "Neck band — so short it will not stretch over the head without distorting." |
| **Confidence** | high on a woven collar; medium on a knit band, because how far a band stretches depends on the measured stretch, which is often estimated |
| **Points at** | the collar stand or band, and every neckline edge it is sewn to |
| **Suggested check** | "Lengthen the band and the neckline together — changing one alone changes how it is eased on." |

---

### 3.8 Sleeve length

| | |
|---|---|
| **Needs** | body arm length to the wrist; the garment's sleeve end position on the draped body; whether the sleeve is banded or hemmed |
| **Calculation** | distance from the sleeve end to the body's wrist landmark, along the arm |
| **If unavailable** | no arm landmarks, or a short sleeve where no target length is stated → for a short sleeve, report the position reached, not a verdict |
| **Normal** | "Sleeve length — reaches the wrist." |
| **Worth a look** | "Sleeve length — 3 cm short of the wrist." |
| **Needs attention** | "Sleeve length — well short of the wrist for a long-sleeved shirt." |
| **Confidence** | medium — a sleeve's apparent length depends on the pose, and the fitting uses one |
| **Points at** | the sleeve, and the cuff or hem edge |
| **Suggested check** | "Check against the arm position you expect in wear; a straight-arm pose reads longer than a bent one." |

---

### 3.9 Garment length

| | |
|---|---|
| **Needs** | the hem position on the draped garment; body landmarks for hip and seat; the intended length if R&D stated one |
| **Calculation** | hem position relative to the stated target, or to the body landmark the category implies |
| **If unavailable** | no stated target and the hem falls below the body model → report the measured length without a verdict |
| **Normal** | "Length — as specified." |
| **Worth a look** | "Length — 2 cm shorter than specified." |
| **Needs attention** | "Length — too short to stay tucked in." |
| **Confidence** | high when R&D stated a target length; low when inferred from the category |
| **Points at** | the lower edges of the body panels |
| **Suggested check** | "Confirm the intended length is measured the same way — from the high shoulder point, or from the back neck." |

---

## 4. Writing the messages

For R&D designers and IE users, not for engineers.

**Do** say what a person would see on the garment: *"the fabric is pulling where
the sleeve meets the body"*. **Do not** say *"p90 strain 0.084 above residual"*.

| Avoid | Use |
|---|---|
| strain, residual strain, p90 | pulling, tight, straining |
| ease (unqualified) | room, room to move |
| compliance, stiffness, α | how much the fabric gives |
| collision, penetration | pressed into, pushed against |
| solver, converged, substeps | — do not mention it at all |
| negative ease | "cut smaller than the body, and stretched on" |

The numbers stay — a designer wants them — but underneath the sentence, not
inside it. One sentence a person can act on, then the figures.

**Never** write a message that implies the software will fix it. "Add 2 cm to
the chest" reads as an instruction the system is about to carry out. "Check how
the chest width is shared between front and back" reads as what it is: a
suggestion to a person who owns the decision.

---

## 5. Why the software must never edit the pattern

The single most important rule in this specification.

1. **The pattern is the manufacturing record.** Cloth is cut from it and money
   is spent against it. It has an approval, an author and a frozen revision
   history; an automatic edit has none of those, and would be a change to a
   controlled document that nobody signed.

2. **A fitting is evidence, not authority.** It is one body, one pose, one
   fabric profile — often estimated — and one static drape. A finding is a
   reason to look, not a measurement of the garment.

3. **The Assistant cannot see intent.** A relaxed fit and a too-large garment
   are identical in the numbers. Only the designer knows which this is, and an
   automatic correction would quietly remove design decisions.

4. **Patterns are interdependent.** Widen a sleeve and the cap seam no longer
   matches the armhole. A change that satisfies one finding breaks a seam the
   Assistant was not looking at.

5. **A corrected pattern nobody reviewed would still carry an approval.** This
   is the real danger: the edit would inherit the trust of the revision it
   modified, and the next person could not tell which lines a person drew and
   which a program moved.

So: the Assistant reports, names the pieces and edges involved, and suggests
what to check. A designer makes the change, in the pattern tools, as a new
revision with their name on it — and the fitting that prompted it goes stale
and has to be re-run, which is how the loop closes honestly.
