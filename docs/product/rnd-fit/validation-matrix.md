# Validation matrix

**Lane B · validation pack · revised 1 Oct 2026.**
Eighteen cases. Each one states what goes in, what must come out, and what it
would mean if something else did.

**Revision note.** Two corrections. The first draft's VM-10 claimed the
post-assembly geometry check catches a reversed seam; **it does not**, and the
case is rewritten as a prevention case plus an explicit statement of the blind
spot (VM-11, VM-12). The first draft also said "ten of eighteen are refusals"
when there were nine; the counts below are recomputed and stated per group.

---

## 1. How to read this

These are **product** cases, not unit tests. Each asks: given this input, does the
product do the honest thing? Lane A may implement any of them as an automated test
or run them by hand.

### The three outcomes

| Outcome | Meaning |
|---|---|
| **Fitting** | A drape is produced and findings are reported |
| **Refused** | No drape. A named readiness failure, and what to do about it |
| **Partial** | A drape is produced; named findings are **withheld** or marked |
| **Undetected** | A drape is produced and **it is wrong, and nothing catches it**. Exactly one case, VM-11, and it is in the pack to be written down rather than passed |

A **Partial** is not a degraded Fitting. It is the correct outcome whenever the
drape is watchable but a number would be biased.

### Evidence

Every case records: the readiness codes raised, which sewing-line source was used
(published / derived / cut boundary), the fabric grade, the rule set version, the
confirmed seam alignments, and whether scale was self-consistent or externally
verified.

### Counts

| Group | Cases | Expected outcome |
|---|---|---|
| **A** — must produce a fitting | VM-01 … VM-06 | 6 Fitting |
| **B** — must refuse | VM-07 … VM-10, VM-12 … VM-14 | **7 Refused** |
| — the blind spot | VM-11 | 1 Undetected |
| **C** — must run and hold back | VM-15 … VM-18 | 4 Partial |

**Seven of eighteen are refusals.** Six produce a full fitting, four produce a
fitting with something withheld, and one — VM-11 — produces a wrong fitting that
nothing in this specification detects. 6 + 7 + 1 + 4 = 18.

VM-11 is numbered inside Group B because it is the case the Group B refusals exist
to prevent, but it is **not** a refusal: by the time the wrong confirmation has been
made, there is nothing left to refuse on.

---

## 2. Group A — must produce a fitting

### VM-01 · The real export, fully mapped

**Input.** `test/fixtures/rnd/clo-tshirt-aama.dxf` — the genuine CLO 7.1.178
export. Five pieces, two of them the separately-drawn left and right sleeves at
`QUANTITY: 1` each. Roles assigned, every seam's alignment confirmed, seam
allowance stated so a sewing line is derived, a measured jersey profile, a body
with a stated chest girth.

**Must produce.** A Fitting. Chest reported by the **knit** path — flat-pattern
girth against body girth as the primary number (`fit-assistant-rules.md` §4.2).
Collar and bicep reported. Garment length reported only if R&D stated a target.
Stomach, hem, shoulder, armhole and sleeve length **withheld** for want of
landmarks (`fit-assistant-rules.md` §3.4) — all five, each saying so.

**Why it is case one.** This is the only input in the pack that is real. If this
does not work, nothing above it means anything.

### VM-02 · Form B sleeves, independently confirmed

**Input.** As VM-01, with the two sleeve pieces linked by `pairedWith`, and the
armhole alignment confirmed **separately** on each side.

**Must produce.** A Fitting with two independent armhole mappings. Evidence shows
both `pieceRef`s and records each confirmation as independent.

**Must not.** Require the two pieces to be merged, or apply one confirmation to
the other by inference (`garment-template-contract.md` §4.4, §4.7).

### VM-03 · Form A sleeve, one piece cut twice

**Input.** A tee drawn with a single sleeve outline, `cutQuantity: 2`,
`symmetry: mirrored-pair`. Confirmed once.

**Must produce.** A Fitting with two sleeves. Warning W9: the confirmation was
**propagated**, naming which side was confirmed and which inherited.

**Why.** Both production forms are legitimate (`garment-template-contract.md` §4.7) and the evidence must
distinguish them — a propagated confirmation is weaker than two real ones.

### VM-04 · A short-sleeved, band-collar woven shirt with no yoke

**Input.** Front, back, two sleeves with no cuff, a collar stand and no fall, no
separate upper-back panel. A measured poplin profile, `behaviour: woven`. A
published sewing line.

**Must produce.** A Fitting. Chest by the **woven** path — pattern, draped,
body, strain and clearance together — with the convex cross-section limitation
stated on the girth finding (`fit-assistant-rules.md` §4.1). W4 for each absent optional piece.

**Why.** The first draft's required-piece list would have **refused this shirt**.
It is an entirely ordinary garment and it must pass (`garment-template-contract.md` §6.3).

### VM-05 · A polo with placket and flat collar

**Input.** Front, back, two sleeves, top and under placket, flat collar, cuff
bands. Knit pique profile.

**Must produce.** A Fitting. The collar simulated lying flat, with the `garment-template-contract.md` §7 sentence
about roll on the result. Knit girth path. Compound neckline seam: collar join run
against front neck + placket top + back neck, contiguous from a stated anchor.

### VM-06 · A rotated piece on the marker

**Input.** VM-01 with one body piece rotated 37° on the marker, its grain vector
rotated with it in its own local frame.

**Must produce.** A Fitting **numerically identical** to VM-01 in every girth
finding.

**Why this is the grain case.** Grain is resolved in the piece's own coordinates
(`garment-template-contract.md` §4.8). If this result differs from VM-01, grain is being read off the marker —
the exact error the first draft specified.

---

## 3. Group B — must refuse, and the one case that cannot be refused

### VM-07 · No unit

**Input.** A DXF stating no unit anywhere.

**Must refuse.** R2. **Must not** assume millimetres or inches — the two differ
by 25.4×, and our own parser once reported inches for every unit-less file
because `Number("")` is `0`.

### VM-08 · A required role unassigned

**Input.** A woven shirt with front, back and a neck finish, and the sleeves
unassigned.

**Must refuse.** R3, naming the sleeve pieces. The required list is short on
purpose (`garment-template-contract.md` §6.3), so a refusal here means something genuinely structural is absent.

### VM-09 · A seam with no confirmed alignment

**Input.** VM-01 with one armhole seam mapped but its `alignment` left
unconfirmed.

**Must refuse.** R4, naming that seam and that side.

**Why this refusal exists.** It is the only defence against a reversed seam. See
VM-11.

### VM-10 · A compound side that is not contiguous

**Input.** An armhole whose body side lists the front armhole run and the back
armhole run with a gap between them, or with the two travelling in opposite
directions.

**Must refuse.** R6. **Must not** silently re-order or reverse the runs to make
them fit (`garment-template-contract.md` §4.4, M1).

### VM-11 · A reversed sleeve, confirmed wrongly — the blind spot

**Input.** VM-01 with the left sleeve's armhole alignment confirmed **the wrong
way round**: cap start to armhole end. Everything else correct and confirmed.

**Must happen.** The fitting **runs**, and produces a believable garment with a
twisted sleeve nobody is told about.

**This case is in the pack to be documented, not passed.** It records the known
limit: piece perimeter, seam length and scale are all **identical** to the correct
assembly, so Lane A's fidelity gate passes it, and no downstream check in this
specification detects it. The product's only defence is the confirmation step and
its visual orientation preview (`garment-template-contract.md` §4.5).

**It is a failure of this case** if any surface claims the reversal was or could be
caught after assembly, or if the fitting carries a confidence it has not earned.
The sentence from `garment-template-contract.md` §4.6 must be present on the result.

### VM-12 · Seam-length mismatch beyond the template's ease

**Input.** A sleeve cap 18% longer than the armhole it is mapped to, where the
template allows 5%.

**Must refuse.** R7, with both lengths and the allowance. This is the
**pre-simulation** check on declared lengths, raised before any mesh exists (M4) —
distinct from the post-meshing fidelity gate, which compares declared length to
sewn length.

### VM-13 · Uncovered perimeter, never confirmed

**Input.** A tee where the sleeve hems are neither mapped as sewn nor confirmed as
finished boundary.

**Must refuse.** R5, **showing the uncovered portions on the piece**, and offering
one confirmation for the remainder rather than one per edge (`garment-template-contract.md` §4.11, decision 8).

**Must not.** Demand a declaration per edge — the first draft's rule, which made a
first fitting cost a dozen pointless clicks.

### VM-14 · A zeroed fabric profile

**Input.** A profile present, with `weightGsm: 0` and every stiffness at zero —
which is what the adapter's presence-only check accepts today.

**Must refuse.** On the missing weight. **Must not** produce a drape: zero
gravity and zero stiffness give cloth that looks like cloth and behaves like
nothing, and it is indistinguishable on screen from a real result.

---

## 4. Group C — must run and hold back

### VM-15 · Cut boundary only, no allowance

**Input.** VM-01 with no seam allowance stated and no published sewing line, so no
sewing line can be constructed.

**Must produce.** A **Partial**: a drape marked **non-authoritative**, with
**every dimensional finding withheld** — chest, waist, hem, bicep, collar
(`garment-template-contract.md` §4.12 step 4, W2). Shape observations remain.

**Must not.** Report a girth and subtract a nominal allowance from it. The error is
not a constant offset on a number: sewing on the cut line changes **where the
pieces meet and how they drape**. And it is never called "slight" — on a chest
with two side seams and two armholes, 10 mm of allowance is of the order of 40 mm.

### VM-16 · An unclassifiable fabric

**Input.** A profile with plausible weight and stiffness but `behaviour` unstated
and unconfirmable.

**Must produce.** A **Partial** with chest, waist and hem **withheld**, saying the
product cannot tell whether the cloth stretches, and that the two kinds are judged
on different evidence (`fit-assistant-rules.md` §4.3).

**Must not.** Default to woven. Defaulting reverses which number is primary and
would report a knit's draped conformance as a good fit.

### VM-17 · A knit two sizes too small

**Input.** A jersey tee whose flat-pattern chest girth is far below the body's,
with a measured knit profile.

**Must produce.** A Fitting that reports the chest as **much too tight**, on the
flat-pattern-versus-body difference and on strain, with the `fabric-profile-contract.md` §2.2 note that the
linear material model **understates** resistance near the stretch limit.

**It is a failure** if the garment's draped girth being close to the body's is
read as a good fit. It will be close — the body makes it close. This is the single
case that proves the knit path exists.

### VM-18 · A stale fitting

**Input.** A confirmed mapping and a completed fitting, then the pattern revision
changes.

**Must produce.** The existing fitting marked **stale**, R11 raised on any attempt
to re-run against the new revision with the old mapping.

**Must not.** Re-point the fitting at the new revision. A fitting is a statement
about one revision and expires with it (`fit-assistant-rules.md` §7).

---

## 5. What this pack does not cover yet

- **Movement.** Every case is one static pose. An armhole that passes standing
  still can bind when the arm lifts, and nothing here tests that.
- **Collar roll and interlining.** Not modelled, so not testable.
- **Grading across a size range.** Each case is one size.
- **Solver convergence under adversarial geometry** — very long thin pieces,
  near-zero-length runs. Lane A's territory, and worth its own cases later.
- **Landmark detection accuracy.** Five findings depend on landmarks that do not
  exist yet (`fit-assistant-rules.md` §3.3); when they do, they need cases of
  their own, including bodies with no defined waist.
- **Two readiness failures have no case here.** R8 (an open or self-intersecting
  outline) and R9 (no fabric profile at all, as distinct from VM-14's zeroed one)
  are specified in `garment-template-contract.md` §8 and not exercised by any of
  the eighteen. Stated rather than quietly left out; neither is hard to add.
