# Plain-language glossary

**Lane B · product specification · revised 1 Oct 2026.**
The words the product puts on screen, and the words it does not.

**Revision note.** Adds the vocabulary this revision introduced — grain as a
vector, sewing line versus cut boundary, the knit and woven evidence paths,
landmarks, verified versus self-consistent scale — and corrects two entries: a
published zero is not an unknown, and the "stale" entry's wording.

---

## 1. How to use this

Anything in §2–§6 may appear in the interface. Anything in §7 may not, however
convenient it is.

The audience is a sampling room. Everyone there knows what a yoke is and nobody
there needs to know what a compliance value is.

---

## 2. The garment

| Word | What we mean |
|---|---|
| **Piece** | one outline in the pattern — one shape to be cut |
| **Role** | what a piece is *for* in this garment. Assigned by a person, never read from the piece's name |
| **Run** | a stretch of a piece's edge, between two marked points |
| **Seam** | two sets of runs sewn to each other |
| **Alignment** | which end of one run meets which end of the other. The thing a person confirms, and the thing nothing can check afterwards |
| **Cut boundary** | the line the cloth is cut along — the outer edge of the piece |
| **Sewing line** | the line the stitching actually runs along, inside the cut boundary by the seam allowance. **This is the line that decides the garment's size** |
| **Seam allowance** | the strip between the two: cut here, sew there |
| **Cut on fold** | the pattern shows half the piece; the cloth is folded and cut as one whole piece, with no seam at the fold |
| **Mirrored pair** | one drawn piece, cut twice as mirror images |
| **Paired pieces** | left and right drawn separately, and linked |
| **Grain** | the direction of the threads in the cloth. Stored as a **direction on the piece**, so it stays correct however the piece is turned on the marker |
| **Ease** | how much bigger the garment is than the body. Can be negative on a knit, which is normal |

---

## 3. The fitting

| Word | What we mean |
|---|---|
| **Fitting** | one drape of one pattern revision on one body, with the findings that came out of it |
| **Finding** | one observation about one part of the garment |
| **Evidence** | the measurements and settings a finding came from |
| **Clearance** | the gap between the cloth and the body |
| **Strain** | how hard the cloth is being stretched. On a knit, read as *how far into its stretch* rather than as a force |
| **Flat-pattern measurement** | measured on the pattern, flat, on the sewing line |
| **Draped measurement** | measured on the settled garment, on the body |
| **Landmark** | a named place on the body — the chest plane, the shoulder point — that a finding measures at |
| **Rule set** | the numbers R&D considers right for a category, fit and fabric. Versioned, with an author |
| **Stale** | the pattern changed after this fitting was made, so the fitting describes a garment that no longer exists. It is kept as a record and is not updated to match |

---

## 4. The three states of a finding

| On screen | Means |
|---|---|
| **Reported** | we measured it and here it is |
| **Withheld** | we could measure something, but it would be misleading, so we are not saying it. Always with the reason |
| **Not available** | this finding needs something this fitting does not have — usually a place on the body nobody has defined |

A withheld finding is a correct result. It is not an error and must never look
like one.

---

## 5. How sure the fitting is

| On screen | Means |
|---|---|
| **Measured cloth** / **Estimated cloth** | whether anybody actually tested this fabric |
| **Sewing line published / derived / not available** | which of the three the fitting used — and the third means girths are withheld |
| **Scale verified** | at least one length was checked against something outside the pattern file |
| **Scale self-consistent** | the file agrees with itself. It can still be uniformly wrong by a factor, and only an outside check rules that out |
| **Confirmed by** | who agreed the mapping, and when |

---

## 6. Zero and unknown are different

| On screen | Means |
|---|---|
| **0** | we looked and there are none. The file publishes notches and this piece has no notches |
| **Not published** | the file does not carry this information at all |
| **—** | we have not asked anyone yet |

These look alike and mean opposite things. A piece with "0 notches" is a piece
somebody drew without notches; a piece with "notches: not published" is a piece
whose notches we cannot see. Never print `0` for the second.

---

## 7. Words we do not put on screen

| Not this | Because |
|---|---|
| compliance, α, XPBD, constraint, residual | solver vocabulary; no reader can act on it |
| convex hull | the measuring method's limitation is said in words instead |
| vertex, mesh, triangle, topology | the reader cares about cloth |
| tensor, magnitude, norm | a number with no meaning to a fitter |
| tolerance exceeded | say what is tight, and where |
| validation failed | say what is missing, and who can supply it |
| confidence 0.55 | say what is uncertain and why |

---

## 8. Sentences that are wrong however they are worded

- **Anything giving an instruction.** "The chest is tight" — never "add 2 cm".
  The software does not change patterns.
- **Any number on a withheld finding.** If the sewing line could not be built, there
  is no girth to report, not even approximately.
- **"Fits well"** on a knit, based on the cloth following the body. A knit follows
  the body whatever size it is.
- **"No problems found"** when findings were withheld. Say which were not checked.
- **Anything implying a reversed seam would have been caught.** It would not.

---

## 9. Two words we are careful with

**"Approved."** A pattern revision is approved. A *fitting* is never approved — it
is evidence somebody read. Saying a fitting is approved invites a sample to be
signed off against a picture.

**"Correct."** The product says what it measured and what the rule set expects. It
does not say a pattern is correct, because the pattern-maker decides that and often
has a reason the product cannot see.
