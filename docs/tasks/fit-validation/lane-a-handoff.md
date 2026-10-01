# Lane B → Lane A handoff

**Revised 1 Oct 2026**, after an adversarial review of Lane B's own first draft.
Documentation only. No application code, schema, route or test was touched.

---

## 1. Read this first: the first draft was wrong in four places

Lane B reviewed its own output against the real DXF export, the live schemas, the
`cad.zip` implementation and Lane A's decision record, and found four claims that
would have caused Lane A to build the wrong thing. All four are corrected. If you
read the previous version (`f2970a13`), these are the deltas that matter:

| Was | Now |
|---|---|
| The post-assembly geometry check catches a reversed seam | **It cannot.** Perimeter, seam length and scale are all identical for a reversed sleeve. Defence is prevention: mandatory confirmed `alignment`, with a visual orientation preview. `garment-template-contract.md` §4.5 |
| Grain is a `lengthwise` / `crosswise` label derived from the drawing | **A vector in the piece's own coordinates.** Every piece in the real export has a grainline at ~90° because that is the selvedge; the label said nothing about the garment. §4.8 |
| Chest, waist and hem ease read off the draped garment | **Split by fabric.** A knit drapes to the body's girth whatever size it is, so flat-pattern vs body girth is primary for knits. Two of three categories in scope are knit. `fit-assistant-rules.md` §4 |
| An unpublished seam allowance is a "slight" error, warned about | **~40 mm on a chest girth** — a whole fit band. A sewing line is published, derived, or the dimensional findings are withheld. §4.12 |

Plus five structural corrections: a documented body-landmark contract (the
findings needed one and nothing in the record provides it), support for
separately-drawn left/right pieces, a required-piece list narrowed to your first
template, a workable boundary-coverage rule, and construction order demoted out of
readiness.

---

## 2. The six documents, and what each is for

| Document | Answers |
|---|---|
| `docs/product/rnd-fit/garment-template-contract.md` | What a fitting must be given, where each thing comes from, and what stops it. The name-free seam contract |
| `docs/product/rnd-fit/fabric-profile-contract.md` | What cloth must be described as, and what happens per missing value |
| `docs/product/rnd-fit/fit-assistant-rules.md` | The nine findings, the body contract, and which four are actually available in release one |
| `docs/product/rnd-fit/validation-matrix.md` | Eighteen cases: six fittings, seven refusals, four partials, and one documented blind spot |
| `docs/product/rnd-fit/plain-language-glossary.md` | The words on screen, and the forbidden ones |
| `docs/tasks/fit-validation/lane-a-handoff.md` | This file |

The body-landmark contract is **§3 of `fit-assistant-rules.md`** rather than a
seventh file, because landmarks exist only to serve findings and the useful part is
the landmark → dependent-finding mapping. It introduces no schema and asks for none
in this release.

---

## 3. Lane B agrees with Lane A's decisions

Read `docs/decisions/rnd-fit-simulation.md` and found nothing to argue with:

- **Millimetres as the one internal unit**, and a unit-less pattern **refused**.
  Lane B's R2 is the same refusal. Our own parser shipped the 25.4× bug this
  prevents, because `Number("")` is `0`.
- **Garment knowledge in `fit/templates/`, the solver ignorant of "sleeve".**
  This is the whole shape of §4 and §5 of the contract: roles and run vocabularies
  are per template, and a seam is geometry.
- **The fidelity gate fails rather than warns.** Agreed, and Lane B adds the
  distinction it needs: a **pre-simulation** check on declared lengths (R7) and the
  **post-meshing** gate on built geometry are two different checks at two different
  moments, and neither replaces the other.
- **Leaving `SeamGraph.js` and `FitAssistant.js` behind.** Lane B reached the same
  conclusion from the other direction: the `"Coller"` lookup and the "Executive
  shirt M, 0.8″ mesh" residuals are why nothing here holds a universal threshold.
- **The drape is read-only evidence and goes stale.** `fit-assistant-rules.md` §7
  and VM-18.

### One place Lane B asks for slightly more than your record

Your scope says "front, back, sleeves, and an **optional** collar band". Lane B's
first-release requirement is front, back, sleeves and **a neck finish** — satisfied
by a band, a collar pair, or a declared facing, so the specific piece stays
optional but *some* finish is required.

The reason: an unfinished neck opening has no defined finished length, and the
collar/neck finding is one of only four available in release one. If you would
rather the neck finish be fully optional, the consequence is that the collar
finding is withheld whenever it is absent — say so and Lane B will record that
instead. Nothing else in the pack depends on it.

---

## 4. Consume in this order

1. **`garment-template-contract.md` §4** — the data shape. Runs, anchors, seams as
   ordered sequences, and `alignment` as a mandatory confirmed value.
2. **§8 R1–R11** — the readiness failures. These are the gate before a job is
   accepted.
3. **`fabric-profile-contract.md` §4 "Partial profiles"** — per-value behaviour.
   The rule is: missing values that change *where* cloth settles stop the fitting;
   missing values that change *how it gets there* warn.
4. **`fit-assistant-rules.md` §3.4** — which four findings release one can
   honestly report. Build those; make the other five say "not available".
5. **`validation-matrix.md`** — VM-01 first. It is the only case built on a real
   file.

---

## 5. The gaps Lane B found in the record

Not asking for schema changes in this release. Listing them so they are not
discovered mid-implementation.

| Gap | Where | Consequence today |
|---|---|---|
| **No body landmark structure.** `avatarSchema.measurements` is `Schema.Types.Mixed`, default `{}`; `poseRef` is a free string | `models/CMS_Models/RnD/PatternRevision.js` | five of nine findings have nowhere to measure. §3.3 |
| **No seam alignment field.** `seamPairingSchema` has `fromEdge` / `toEdge` and no orientation | same file | the one failure nothing downstream can catch is unrepresentable. §4.5 |
| **Seams pair one edge to one edge** | same file | a set-in sleeve cannot be expressed; its body side is 2–3 runs |
| **No woven/knit flag on fabric** | `fabricSchema` | the Fit Assistant's primary evidence path is undecidable. `fabric-profile-contract.md` §2.1 |
| **Thickness doubles as collision offset** | `fabricSchema` | the archive's own preset has them a factor of 13 apart |
| **No fabric grade, source, damping, shear, friction, or stretch load** | `fabricSchema` | measured and guessed cloth are indistinguishable |
| **Readiness is a presence check** | `services/rnd/simulationAdapter.service.js` — `has("fabrics", (inputs.fabrics \|\| []).length > 0)` | an all-zero profile passes and drapes. VM-14 |
| **No sewing line anywhere** | our DXF publishes no layer 14; `PatternMeshBuilder.js` has no inset logic | every girth is biased by the allowance until a sewing line is derived. §4.12 |
| **No notches, no mirror line** | the real export publishes layers 1, 2, 3, 7, 8 only | anchors fall back to arc-length fractions; cut-on-fold must be stated |

---

## 6. The constraint that shapes everything

> A fitting that cannot be trusted must not be produced.

A believable drape with the wrong dimensions gets a sample approved against it.
That is the cost of being wrong here, and it is why this pack has seven refusals,
four partials, and withholds five of nine findings in the first release.

It is also why VM-11 exists as a documented blind spot rather than a passing test.
A reversed seam produces a believable garment and nothing catches it. Writing that
down is more useful than a check that does not work.

---

## 7. What Lane B is not asking for

- No schema migration, route, model or test in this release.
- No trousers, jackets or any fourth category.
- No universal threshold anywhere. Every number is a rule set's, held by R&D,
  versioned, with an author.
- No change to `docs/tasks/current-task.md` or any file Lane A owns. Lane B has
  not touched them.

---

## 8. Open questions for R&D, not for Lane A

1. **Seam allowance** — one value per garment, or per run? Per run is the truth and
   per garment is what anybody will actually enter.
2. **The waist** — on a body with no defined waist, is a detected waist acceptable,
   or is the finding withheld? Lane B's draft withholds it.
3. **Stretch load** — what force are stretch percentages measured at here? Without
   it, two profiles are not comparable.
4. **Rule sets** — who authors them, and what is the first set for a basic tee?
   Nothing in this pack works without one, and nothing in this pack invents one.
