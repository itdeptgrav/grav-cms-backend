# Fabric profile contract

**Lane B · product specification · 1 Oct 2026.**
What a fitting needs to know about cloth, where each number comes from, and how
honest the answer is.

---

## 1. The problem this contract exists to solve

A cloth simulation does not want the numbers a mill prints on a swatch card.

A simulator wants **compliance** — how far a thread gives under a given load,
expressed so that zero means rigid. The archive's fabric file holds values like
`warpStretch: 4e-5` and `bend: 6e-2`, in inches per ounce-force.

A merchandiser, a fabric supplier and an R&D designer deal in different
quantities entirely: *"120 gsm cotton poplin"*, *"4-way stretch"*, *"15 % on
the weft"*, *"same as last season's"*.

Neither vocabulary converts to the other without a stated assumption, and the
assumption is where the trust goes. `4e-5` cannot be checked by anybody in a
sampling room. `15 %` cannot be used by a solver without knowing *15 % under
what load*.

**So a fabric profile records both, and never only the solver's number.**

| Layer | Who reads it | Example |
|---|---|---|
| **What was observed** | designers, merchandisers, suppliers | "stretches 15 % across, under a 2 kg pull on a 5 cm strip" |
| **How it was turned into physics** | whoever debugs a wrong drape | the conversion used, named and versioned |
| **What the solver received** | the solver | a compliance |

A profile that carries only the third layer is a number nobody can argue with,
which sounds like a strength and is the opposite: when a drape looks wrong,
there is no way to tell whether the pattern, the mapping or the fabric was the
problem.

---

## 2. The profile

### 2.1 Identity and provenance

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | What the pattern room calls it |
| `appliesTo` | yes | Which pieces. Empty means every piece without its own profile |
| `category` | yes | §3 — **woven**, **knit** or **non-woven**; this changes which rules apply |
| `source` | yes | Where these values came from (§4) |
| `confidence` | yes | `measured`, `supplied`, `estimated` (§4) |
| `measuredOn` | when measured | Date, and by whom |
| `supplierRef` | when supplied | The document or swatch the numbers came from |

### 2.2 The physical values

| Field | Unit | Required for a fitting | If absent |
|---|---|---|---|
| `weight` | g/m² | **yes** | the garment has no mass; refuse |
| `thickness` | mm | no | a default thickness is used and the fitting says so |
| `stretchWarp` | % extension at a stated load | **yes** | refuse |
| `stretchWeft` | % extension at the same load | **yes** | refuse |
| `shear` | % skew at a stated load, or a grade (§5) | no | derived from category and stretch, marked estimated |
| `bending` | mm of drape over a stated overhang, or a grade | no | derived from weight and category, marked estimated |
| `friction` | against skin: grade or coefficient | no | category default, marked estimated |
| `selfFriction` | cloth against itself | no | category default, marked estimated |
| `grainDirection` | which way the warp runs on the piece | **yes, per piece** | see §6 |

**The stated load is part of the value.** "15 % stretch" is not a measurement;
"15 % under 2 kg on a 5 cm strip" is. A profile that records a percentage
without its load is marked `estimated` however it was obtained, because nobody
downstream can reproduce it.

### 2.3 What the solver is given

Derived, never typed by a person, always recorded alongside its inputs:

| Derived | From |
|---|---|
| areal density | `weight` |
| warp compliance | `stretchWarp` + load + `conversionVersion` |
| weft compliance | `stretchWeft` + load + `conversionVersion` |
| shear compliance | `shear`, or category + stretch |
| bend compliance | `bending`, or `weight` + category |
| collision offset | `thickness`, or category default |

`conversionVersion` is recorded on the fitting. When the conversion changes,
every earlier fitting still says which one it used, and nobody has to guess why
last month's drape looked different.

---

## 3. Category changes the rules, not just the numbers

| | Woven | Knit | Non-woven |
|---|---|---|---|
| Stretch along grain | very little | moderate to large | little |
| Stretch across grain | a little more than along | often much larger | little |
| Bias behaviour | **skews readily** — the diagonal is the stretchy direction | less pronounced | little |
| Grain sensitivity | **high** — cut off-grain and it hangs wrong | lower, but ribs still have a direction | low |
| Typical neck finish | a collar or facing | a stretched-on band | — |
| Ease needed to move | **more** — the cloth will not give | **less**, and can be negative | more |

Two consequences for the product:

1. **Negative ease is normal on a knit and wrong on a woven.** A knit T-shirt
   measuring smaller than the body is how it is meant to be worn. The same
   number on a poplin shirt is a garment that cannot be done up. The same
   comparison therefore produces opposite verdicts, which is exactly why
   `fit-assistant-rules.md` has no universal thresholds.
2. **A woven run with knit values is a wrong fitting that looks fine.** The
   garment drapes, nothing fails, and every ease reading is generous because the
   cloth gave where real cloth would not. It is a readiness failure
   (`VM-17`), not a warning.

---

## 4. Where values come from, and how far to trust them

| Confidence | Meaning | Shown as |
|---|---|---|
| **measured** | tested on this cloth, with the method recorded | "Measured 14 Sep 2026" |
| **supplied** | from the mill or supplier's own data | "From the supplier's specification" |
| **estimated** | derived from category, weight or a similar fabric | "Estimated from weight and type" |

`estimated` is not a failure state and must not be treated as one. Most first
fittings will be estimated and they are still useful — as long as the result
says so, and as long as no finding in `fit-assistant-rules.md` claims high
confidence on top of estimated cloth.

**The rule that keeps this honest:** a fitting is only as confident as its
least confident input. An estimated fabric produces an estimated fitting, and
the Fit Assistant's own confidence is capped accordingly.

### Partial profiles

A profile with weight and stretch but nothing else is usable. The missing
values are filled from category defaults, each marked `estimated`
individually — not the whole profile. A designer who measured the stretch and
guessed the bending should see exactly that.

---

## 5. Grades, for people who do not have a lab

Most houses will never measure bending rigidity. They can still answer a
question a person can answer by handling the cloth:

| Grade | Bending — "hold a strip over the edge of a table" | Friction — "slide it against skin" |
|---|---|---|
| 1 | flops straight down | very slippery |
| 2 | soft curve | slippery |
| 3 | holds a gentle arc | ordinary |
| 4 | stands out noticeably | grippy |
| 5 | nearly rigid | very grippy |

A grade is `estimated`, always. It is in the contract because a fitting run on
a sensible guess that somebody made by touching the fabric is far better than
one run on a default nobody chose — and because the grade is reproducible by
the next person in a way `6e-2` is not.

---

## 6. Grain is a property of the piece, not only the cloth

The cloth has a warp direction. The **piece** has a grainline, which says how
the piece is laid on the cloth. The two together decide which way that piece
stretches.

- Where AAMA layer 7 exists, the piece's grain is **derived**.
- Where it does not — and our current exports do publish layer 7, but imported
  patterns may not — it is **stated** per piece.
- A simulated piece with no grain on a fabric whose warp and weft differ
  meaningfully is a readiness failure (`VM-16`), because there is no defensible
  answer for which way it gives.

A band cut across the grain is the everyday case that makes this matter: the
same cloth, turned ninety degrees, is the reason the neck band stretches over a
head and the front panel does not.

---

## 7. What this contract deliberately does not do

- It does not invent a fabric. A piece with no profile and no garment-level
  profile stops the fitting.
- It does not average two fabrics to cover a garment that has both. Pieces
  carry their own profiles.
- It does not treat a supplier's marketing description as a measurement.
  "4-way stretch" is a category, not a number.
- It does not hide the conversion. The compliance the solver received is
  readable, beside the observation it came from.

---

## 8. What is missing from the record today

Stated so Lane A does not have to discover it.

`PatternRevision.simulationInputs.fabrics[]` currently holds: `pieceRefs`,
`name`, `weightGsm`, `thicknessMm`, `stretchWarpPercent`, `stretchWeftPercent`,
`bendingRigidity`, `note`.

Against this contract it is missing:

| Missing | Why it matters |
|---|---|
| `category` (woven / knit / non-woven) | decides which rules apply at all — §3 |
| the **load** the stretch percentages were measured at | without it the percentages are not measurements |
| `shear` | the bias is where a woven actually moves |
| `friction`, `selfFriction` | how the garment sits on the body and on itself |
| `source`, `confidence` | whether a reading may be trusted, and how far |
| `conversionVersion` | why an old fitting and a new one differ |

`grainDirection` is not missing — it lives on the piece, where it belongs.
