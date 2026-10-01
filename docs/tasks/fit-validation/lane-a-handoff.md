# Handoff to Lane A — what to consume, and when

**From Lane B (product specification) · 1 Oct 2026.**
Nothing here blocks Lane A today. It is written so that when the solver needs a
garment description, the description already exists and nobody has to invent
one under deadline.

---

## 1. What Lane B produced

| Document | Answers |
|---|---|
| `docs/product/rnd-fit/garment-template-contract.md` | what a template must describe; the name-free seam contract; the three categories; readiness failures and safe warnings |
| `docs/product/rnd-fit/fabric-profile-contract.md` | what a fitting needs to know about cloth, and how sure it is |
| `docs/product/rnd-fit/fit-assistant-rules.md` | the nine findings, their wording, and why nothing auto-edits |
| `docs/product/rnd-fit/validation-matrix.md` | the eighteen cases the pipeline must eventually pass |
| `docs/product/rnd-fit/plain-language-glossary.md` | the words that go on screen |

**No application code, model, route, test or workspace file was touched.**

---

## 2. Lane B agrees with the decisions Lane A already recorded

Read from `docs/decisions/rnd-fit-simulation.md`. Nothing in Lane B's documents
contradicts any of it, and three of them are load-bearing here:

- **Garment knowledge lives in `fit/templates/`, and the solver below it does
  not know the word "sleeve."** The seam contract is written to make that
  possible: it describes a garment entirely in pieces, edges, runs, directions
  and alignments.
- **A pattern with no stated unit is refused, not assumed.** `VM-13` is the case
  for it, and the reason is the 25.4× error with no visible symptom.
- **A drape is evidence; it goes stale rather than re-pointing.** `VM-18`.

The modules Lane A deliberately left behind — `SeamGraph.js`,
`GarmentAssembler.js`, `collarSupply.js`, `analysis/FitAssistant.js` — are
exactly what these documents replace. `garment-template-contract.md` §1 records
why, with the specific evidence: lookups for `"Coller"`, thresholds measured on
*"Executive shirt M on its base body"*.

---

## 3. Consume in this order

### Now, if it is cheap — otherwise at the template step

**The seam-mapping contract** (`garment-template-contract.md` §4). The one
structural point worth knowing before writing the assembler:

> **A seam joins two ordered *sequences* of edges, not two edges.**

On every garment in scope, the armhole is one sleeve-cap edge sewn to two or
three body edges in order. A contract that paired one edge to one edge cannot
express a set-in sleeve, and discovering that after the assembler is written is
a rewrite rather than a change.

Also worth having early, because both are cheap now and awkward later:

- **Alignment is explicit**, never inferred from outline storage order. A
  reversed seam drapes and looks nearly right (`VM-10`), so it must be impossible
  to express accidentally.
- **Pairing is by normalised position along each side's own total length**, so a
  125-point armhole sews to a 40-point cap. This is how the archive did it and it
  is right.

### At the template step

The three categories (§6) — required and optional pieces, cut quantities,
symmetry, grain, required seams and their order, legitimately unsewn edges.

The conditional-piece rule is the part that bites: a woven shirt may or may not
have a separate upper-back panel, and whether it does changes which edges exist
and which seams are required. §6.3 states it as *"when this role is present,
these seams become required"*.

### At the readiness step

§8 of the template contract: nine readiness failures, seven safe warnings.

This extends what `simulationAdapter.checkInputs()` does today. The current
check asks whether each list has at least one entry — pieces, unit, seam
pairings, fabrics, avatar, render size. That is the right shape and it is not
yet asking whether the mapping is *correct*: nothing currently detects an
unpaired edge, a seam-length mismatch, a reversed alignment, an open outline or
a missing grain.

### At the fabric step

`fabric-profile-contract.md`. The practical point:

> The solver wants a **compliance**. R&D, merchandisers and suppliers deal in
> **percentages, GSM and swatch cards**. A profile must carry both, plus the
> conversion that links them.

A profile holding only `4e-5` is a number nobody in a sampling room can check,
so when a drape looks wrong there is no way to tell whether the pattern, the
mapping or the cloth was at fault.

### Last, after a drape exists

`fit-assistant-rules.md` and `plain-language-glossary.md`. Neither is needed
until there is something to report on.

---

## 4. The gaps Lane B found in the existing record

Named so Lane A does not rediscover them. **Lane B has not changed any of
these** — they are Lane A's to act on, or not.

### `PatternRevision.simulationInputs.seamPairings[]`

Holds `fromPieceRef`, `fromEdge`, `toPieceRef`, `toEdge`, `seamType`, `note`.

| Missing | Why it matters |
|---|---|
| ordered edge geometry and **direction** | without it a seam can be sewn backwards |
| **start/end alignment** | the reversed-sleeve case, `VM-10` |
| **sequences** on each side | a set-in sleeve cannot be expressed as one edge to one edge |
| **easing allowance** and distribution | the difference between a design and a mismatch |
| **fold / symmetry** per piece | our exports publish no mirror line, so cut-on-fold is unstated |
| **layer** | whether a piece is simulated at all |
| **unsewn edges**, declared | "finished" and "not done yet" are different and currently indistinguishable |
| **confidence, confirmedBy, confirmedAt** | a confirmation nobody is attributable for is a guess |

### `PatternRevision.simulationInputs.fabrics[]`

Holds `pieceRefs`, `name`, `weightGsm`, `thicknessMm`, `stretchWarpPercent`,
`stretchWeftPercent`, `bendingRigidity`, `note`.

| Missing | Why it matters |
|---|---|
| **category** (woven / knit / non-woven) | decides which rules apply at all; `VM-17` is a refusal because of it |
| the **load** the stretch percentages were taken at | without it they are not measurements |
| `shear` | the bias is where a woven actually moves |
| `friction`, `selfFriction` | how the garment sits on the body and on itself |
| `source`, `confidence` | whether a reading may be trusted |
| `conversionVersion` | why last month's fitting and this month's differ |

### Role assignment

There is nowhere on the revision to record **which piece plays which part**. It
is the single largest gap: without it a template cannot be applied at all, and
it cannot be derived — our exports name pieces `Pattern_636968`.

---

## 5. The constraint that shapes everything

Worth stating once, plainly, because it decides how much automation is possible.

The genuine CLO export this house produces publishes AAMA layers **1, 2, 3, 7
and 8** — boundary, turn points, curve points, grainline, internal lines.

It does **not** publish layers **4, 5, 6, 13 or 14** — notches, grade points,
mirror line, drill holes, sew line.

Three consequences:

1. **No notches** → seam pairing cannot be derived from registration marks.
   Nothing in the file says which point on the armhole meets which point on the
   cap.
2. **No sew line** → seam allowance is unpublished, so sewing lines are taken as
   cut lines and the garment reads slightly larger than it is. That is warning
   `W1`, and it should appear on every fitting made from these files.
3. **No mirror line** → cut-on-fold is unstated and must be said by a person.

So role assignment and seam mapping are **human work** on the patterns this
house has today. A template makes that work short and checkable; it cannot make
it automatic. Anything built on the assumption that a DXF can be assembled
unattended will fail on the first real file.

Lane A's own decision record already says this — *"arbitrary imported DXF is not
claimed to assemble automatically"* — and this is the evidence for it.

---

## 6. What Lane B is not asking for

- No change to the solver, the units decision, the worker boundary or the
  geometry-fidelity gate. All four are right.
- No schema change today. The gaps in §4 are stated so they can be designed
  once, when the template step arrives — not patched three times.
- No API. These are documents, and they stay documents until Lane A needs the
  shapes.

---

## 7. Open questions for R&D, not for Lane A

These need a person in the sampling room, and nothing can be finalised without
them:

1. **Intended fit per style.** `slim` / `regular` / `relaxed` has to be stated
   somewhere R&D already works. Guessing it from the numbers defeats the point.
2. **House ease bands.** The rule sets need real numbers per category and fit,
   and they must come from this house's own blocks rather than from the
   Executive shirt.
3. **Which bodies.** A fitting is against one body; which bodies represent which
   sizes is a decision nobody has recorded.
4. **Collar grain.** Whether collars are cut lengthwise or crosswise varies by
   house, and the template needs this house's answer.
5. **Measurement method.** Half-chest flat and doubled, or girth on the drape —
   the two differ by enough to matter and must be stated once.
