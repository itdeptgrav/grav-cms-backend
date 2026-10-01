# Fabric profile contract

**Lane B · product specification · revised 1 Oct 2026.**
What the simulation must be told about cloth, where each value comes from, and
what happens when nobody knows.

**Revision note.** This version adds damping (which the archive's own presets
carry and the first draft omitted), separates fabric thickness from collision
offset (they are different quantities and were conflated), states the small-strain
linear approximation the values rely on, and makes the woven/knit classification
explicit because the Fit Assistant's primary evidence now depends on it.

---

## 1. The problem

The record already has a fabric block. `fabricSchema` carries `name`,
`weightGsm`, `thicknessMm`, `stretchWarpPercent`, `stretchWeftPercent`,
`bendingRigidity`, `note` — and `pieceRefs`, so one profile can cover several
pieces.

The simulation adapter checks that a fabric block **exists**:

```js
has("fabrics", (inputs.fabrics || []).length > 0)
```

Presence, not content. A profile with every number at zero passes. The archive's
solver, given zero stiffness, produces cloth with no resistance at all — a drape
that looks like cloth and behaves like nothing.

Hence this contract: what the numbers mean, what units, where they come from, and
what the product does when they are missing rather than wrong.

---

## 2. The profile

### 2.1 Identity and provenance

| Field | Source | Notes |
|---|---|---|
| `profileId` | System | so a fitting can name the exact profile it used |
| `name` | Stated | what the mill or the merchandiser calls it |
| `appliesTo` | Stated | the `pieceRef`s this covers, or the whole garment |
| `behaviour` | **Stated / Confirmed** | `woven` or `knit`. **Load-bearing** — §3 |
| `grade` | System | §5 |
| `source` | Stated | mill datasheet, lab test, measured sample, estimated from a similar cloth, or a preset |
| `measuredBy`, `measuredAt` | Stated | present when `grade: measured` |

`behaviour` is not cosmetic. The Fit Assistant takes a different primary evidence
path for knit and for woven (`fit-assistant-rules.md` §4), and getting it wrong
reverses which number is trusted. It is **never inferred from the fabric's name**
— "interlock" and "poplin" are recognisable to a person and not to software, and a
blend name tells you nothing. Where it is unstated and cannot be confirmed, girth
findings are withheld rather than defaulted to woven.

### 2.2 The physical values

| Value | Unit | What it governs |
|---|---|---|
| `weightGsm` | g/m² | how hard gravity pulls — the single most visible value in a drape |
| `thicknessMm` | mm | the cloth's actual thickness, as a material property |
| `collisionOffsetMm` | mm | how far the cloth surface is held off the body and off itself |
| `stretchWarpPercent` | % extension under a stated load | give along the grain |
| `stretchWeftPercent` | % extension under the same load | give across the grain |
| `shearStiffness` | relative | resistance to the cloth skewing — why a bias panel falls differently |
| `bendingRigidity` | relative | whether it folds in soft rolls or sharp creases |
| `damping` | relative | how fast motion dies out |
| `frictionBody` | coefficient | whether it clings to the body or slides |
| `frictionSelf` | coefficient | whether a fold holds or slips open |

**Thickness is not collision offset (M6).** They were one field in the first draft
and they are different things. Thickness is how thick the cloth is. Collision
offset is a *solver* parameter — the gap the solver maintains so surfaces do not
pass through each other, and it is routinely larger than the cloth, because it
also absorbs mesh coarseness. The archive's own preset shows the gap: thickness
`0.012`, collision gap `0.16` — a factor of thirteen. Using thickness as the gap
produces self-intersection; using the gap as thickness overstates the cloth. Both
are stored, and `collisionOffsetMm` may be adjusted with mesh density without ever
claiming the cloth got thicker.

**Stretch needs its load (M-note).** "40% stretch" is not a number until you say
under what force. A profile states the load its stretch percentages were measured
at; two profiles measured at different loads are not comparable, and the product
says so rather than ranking them.

**The small-strain linear approximation (L3).** The solver treats cloth as
linearly elastic: a stated stretch percentage is converted to a stiffness, and
force is proportional to extension. Real cloth is not linear — a knit is slack,
then compliant, then abruptly firm as the loops lock out. The approximation holds
reasonably in the compliant middle and **understates resistance near the limit of
a knit's stretch**, which is exactly where an undersized garment lives. This is
stated on every knit strain finding, and it is the reason strain is read as
*how far into the range* rather than as an absolute force.

### 2.3 What the solver is given

The solver does not read this profile. It is given per-constraint compliance
values — the archive's α = 1/stiffness — computed from these numbers by a
documented conversion.

That boundary matters: the profile is the thing a person can be asked about and can
check, and the compliance values are an implementation detail that may be retuned
with the mesh. A fitting records both the profile and the conversion version.

---

## 3. Category changes the rules

The same cloth is judged differently by garment, which is why thresholds live in
rule sets and not here.

| | Basic T-shirt | Polo shirt | Basic woven shirt |
|---|---|---|---|
| Typical `behaviour` | knit | knit | woven |
| What gravity dominates | hem and sleeve fall | hem, sleeve, collar | the whole drape |
| What stretch dominates | everything — the garment is held on by it | body and cuff bands | almost nothing |
| Primary girth evidence | flat-pattern vs body | flat-pattern vs body | pattern + drape + strain + clearance |
| Most common unknown | stretch under a stated load | collar interlining, not modelled at all | bending rigidity |

A polo can be either: a pique polo is a knit, and a woven polo exists. `behaviour`
is per profile, never per category.

---

## 4. Where values come from

| Route | Grade | Use |
|---|---|---|
| Lab test on the actual cloth | `measured` | anything, including high-confidence findings |
| Mill datasheet | `stated` | normal use |
| Measured on a sample by R&D | `measured` where the method is recorded | normal use |
| Estimated from a similar cloth | `estimated` | the fitting is marked estimated throughout |
| A preset | `preset` | a starting point, never a conclusion |

**On presets.** The archive shipped three — `executiveShirting`, `linenShirting`,
`jersey`. They are a reasonable starting point and they are not this house's
cloth. A preset may seed a profile; a fitting run on an unedited preset says so,
and cannot produce a high-confidence dimensional finding
(`fit-assistant-rules.md` §3.5).

### Partial profiles

A profile missing a value is normal, and the response depends on which value:

| Missing | Response |
|---|---|
| `weightGsm` | **readiness failure.** Gravity is the drape; there is no defensible default |
| `behaviour` | girth findings **withheld** (§2.1) |
| stretch, with `behaviour: knit` | **readiness failure.** It is the primary evidence |
| stretch, with `behaviour: woven` | warn; treat as near-inextensible, which is nearly true |
| `bendingRigidity` | warn, use a category typical, mark the fitting estimated |
| `damping` | warn, use a solver default — it affects how long settling takes more than where it settles |
| `shearStiffness` | warn, use a category typical |
| friction | warn, use a solver default |
| `collisionOffsetMm` | derive from mesh density, record that it was derived |
| `thicknessMm` | warn; it is not used for collision (§2.2) so the drape survives |

The rule behind the table: **a missing value that changes where the cloth settles
stops the fitting; a missing value that changes how it gets there warns.**

---

## 5. Grades

`measured` → `stated` → `estimated` → `preset`.

The **lowest grade among the simulated pieces** is the grade of the whole fitting.
One estimated lining does not matter much; the product still says estimated,
because the alternative is a reader having to check each piece.

A fitting shows its grade next to its findings, not in a detail panel. "Chest is
tight" from measured cloth and the same sentence from a preset are different
statements and must not look identical.

---

## 6. Grain belongs to the piece, not the fabric

The profile says how the cloth behaves **along** and **across**. Which way those
run on a given piece is the piece's `grainVector`
(`garment-template-contract.md` §4.8).

This split is what makes the contract name-free: one jersey profile serves a body
cut upright and a neck band cut across, and the difference is entirely in the two
pieces' grain vectors. Warp and weft behaviour is resolved per piece from the angle
between the cloth and **that piece's** grain vector in **its own** coordinates —
never from where the piece sat on the marker.

Where a piece has no grain vector and its profile is anisotropic — different along
and across — that is a readiness failure (R10), because the stretch direction is
undefined. Where the profile is effectively isotropic the vector does not change
the result and the failure does not apply.

---

## 7. What this does not do

- It does not model interlining, fusing or tape. A fused collar is stiffer than
  anything in this profile can express, and the fitting says the collar is not
  modelled rather than pretending.
- It does not model seam stiffness. A flat-felled seam is four layers; the seam
  type is recorded in the contract and unused here.
- It does not model shrinkage, relaxation or wash.
- It does not model thread, buttons or any trim.
- It does not model non-linear stretch (§2.2).
- It does not grade a cloth from its name (§2.1).

---

## 8. What is missing from the record today

Stated so Lane A can see the gap without reading the schema:

| Needed | In `fabricSchema` today |
|---|---|
| `behaviour` — woven or knit | ❌ **absent, and the Fit Assistant's evidence path depends on it** |
| the load that stretch was measured at | ❌ absent, so stretch numbers are not comparable |
| `collisionOffsetMm`, separate from thickness | ❌ absent; only `thicknessMm` exists |
| `damping` | ❌ absent |
| `shearStiffness` | ❌ absent |
| `frictionBody`, `frictionSelf` | ❌ absent |
| `grade` and `source` | ❌ absent, so measured and guessed cloth are indistinguishable |
| units on `bendingRigidity` | ❌ unstated — a bare number with no scale |
| a minimum-content check | ❌ the adapter checks presence only |

The first and last rows are the ones that let a fitting be confidently wrong
today: a zeroed profile passes the check, and nothing records whether anybody
measured the cloth.
