# Plain-language glossary

**Lane B · 1 Oct 2026.**
The words this product uses on screen, what they mean, and the words it does
not use.

---

## 1. How to use this

The left column is what a person sees. The right is what it means. If a word
appears on a screen and is not in the left column, it probably needs replacing.

The test for any sentence in this product: **would a sampling-room technician
with no software background know what to do next?** If not, rewrite it.

---

## 2. The garment

| Word we use | What it means |
|---|---|
| **Piece** | One shape cut from cloth. A front, a sleeve, a cuff |
| **Role** | What a piece is for in this garment. Assigned by a person, never read from the piece's name |
| **Edge** | A run along the outside of a piece, between two points on it |
| **Seam** | Two edges sewn together. May be several edges in order on one side |
| **Finished edge** | An edge that is not sewn to anything — a hem, an opening, a fold |
| **Cut quantity** | How many of this piece are in the finished garment |
| **Cut on the fold** | The drawing shows half the piece; the cloth is folded, so the finished piece is whole and has no seam down the middle |
| **Mirrored pair** | Cut twice, the second a mirror image — a left and a right sleeve |
| **Grain** | Which way the threads run on the piece. It decides which way the cloth stretches |
| **Easing** | One edge is deliberately longer than the one it is sewn to, so the cloth curves |
| **Gathering** | A lot of easing, bunched on purpose |
| **Template** | The description of a kind of garment — what pieces it needs and how they are sewn |

---

## 3. The fitting

| Word we use | What it means |
|---|---|
| **Fitting** | The result of putting this pattern on this body in this cloth, and seeing how it sits |
| **Body** | The measurements and shape the garment is being fitted to |
| **Room / room to move** | How much bigger the garment is than the body in a given place |
| **Cut smaller than the body** | What we say instead of "negative ease". Normal on a stretchy fabric |
| **Pulling** | The cloth is being stretched more than it is at rest |
| **Pressed into** | The cloth has nowhere to go and is being pushed against the body |
| **Ready / not ready** | Whether a fitting can be made yet |
| **Stale** | The pattern changed after this fitting was made, so it no longer describes the current pattern |
| **Evidence** | What a fitting is. Something to look at before deciding, never a decision |

---

## 4. The three states of a finding

| On screen | Means | Does **not** mean |
|---|---|---|
| **Normal** | nothing here needs attention | approved |
| **Worth a look** | a designer should check this; it may well be intended | a warning you can ignore |
| **Needs attention** | this would be a problem on a real garment | the software will fix it |

---

## 5. How sure the fitting is

| On screen | Means |
|---|---|
| **Measured** | somebody tested this cloth and recorded how |
| **From the supplier** | the mill's own figures |
| **Estimated** | worked out from the weight and the type of cloth |
| **Not published** | the pattern file does not say. Not zero, not none — unknown |

A fitting is only as reliable as its least reliable input. An estimated fabric
makes an estimated fitting, however good the pattern is.

---

## 6. Words we do not put on screen

Each of these is real and useful to an engineer, and means nothing to the person
reading the result.

| Not this | Say this |
|---|---|
| strain, residual strain, p90 | pulling, tight, straining |
| ease | room, room to move |
| negative ease | cut smaller than the body, and stretched on |
| compliance, stiffness, α, Young's modulus | how much the fabric gives |
| collision, penetration, clearance | pressed into, pushed against, sits clear of |
| solver, converge, substep, iteration, XPBD | — nothing; do not mention it |
| mesh, vertex, triangle, particle | — nothing |
| arc length, parameterisation, normalised position | along the edge |
| topology, manifold, winding | — nothing; say what is wrong instead |
| tolerance exceeded | these two edges do not fit each other |
| null, undefined, NaN | not published |
| validation error | what is actually missing, named |

---

## 7. Sentences that are wrong however they are worded

| Never say | Why |
|---|---|
| "Add 2 cm to the chest" | reads as an instruction the system is about to carry out. Say what to check |
| "Pattern corrected" | nothing in this product edits a pattern |
| "Fit approved" | a fitting is evidence; approval is a person's act on a pattern revision |
| "This garment will fit" | it sat on one body in one pose in one cloth |
| "0 notches" | if the file published none, say "not published" |
| "Simulation failed" alone | say what could not be done and what would fix it |
| "Using default fabric" | there is no default fabric. If none is specified, the fitting is refused |

---

## 8. Two words we are careful with

**Ease.** Widely used in pattern rooms and precise there. On screen we say
"room" instead, because the same word in general English means "easy" and the
finding is read by people outside the pattern room. In the numbers underneath,
"ease" is fine.

**Fit.** Means two different things: the *intended* fit of a style (slim,
regular, relaxed) and whether the garment *fits* a body. We say "intended fit"
for the first, always, and never use the bare word for the second.
