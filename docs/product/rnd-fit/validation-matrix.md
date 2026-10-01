# Validation matrix

**Lane B · acceptance specification · 1 Oct 2026.**
Eighteen cases a fitting pipeline must handle before anybody may rely on it.

---

## 1. How to read this

Each case states the starting conditions, what readiness must decide, what the
simulation must do, what the person is told, what must be kept as evidence, and
— the row that matters most — **what a false result would look like**.

That last row is the point of the document. Every case here has a failure mode
where the software produces something plausible and wrong, and a plausible
wrong fitting is worse than a refusal, because somebody approves a sample
against it.

### The three outcomes

| Outcome | Meaning |
|---|---|
| **Refused** | readiness stopped it. No fitting exists. The reason names what is missing |
| **Ran, qualified** | a fitting exists, and a warning travels with it for ever |
| **Ran** | a fitting exists and nothing qualifies it |

### Evidence

Every run — including a refusal — records: the pattern revision, the template,
the role assignments, the seam mapping and its confirmations, the fabric
profiles with their confidence, the body, the unit and how it was known, the
rule set, and the outcome. A fitting that cannot say what it was made from is
not evidence.

---

## 2. The cases

### Group A — the garment is fine, the fit is the question

These must **run**. A pipeline that refuses them is useless; one that reports
them all as normal is worse.

---

#### VM-01 · Normal fit

| | |
|---|---|
| **Starting conditions** | complete pattern, every role assigned, every edge sewn or declared finished, measured fabric, body matching the size |
| **Readiness** | Ready |
| **Simulation** | Completes. Geometry checks pass: every piece's simulated boundary matches its pattern perimeter, every seam's sewn length matches its pattern length, and the built scale matches the pattern's stated scale |
| **Message** | all nine findings Normal |
| **Evidence** | the full input record, the drape, the nine findings with their numbers and rule set |
| **False result** | reporting a problem that is not there. A pipeline that cannot produce a clean pass on a correct garment will be ignored within a week, and then the real findings are ignored with it |

---

#### VM-02 · Tight chest

| | |
|---|---|
| **Starting conditions** | as VM-01, body chest larger than the garment allows for the stated fit |
| **Readiness** | Ready |
| **Simulation** | Completes. The cloth is visibly strained across the chest |
| **Message** | Chest **Needs attention**, with body girth, garment girth and the shortfall. Stomach may also report |
| **Evidence** | the chest numbers, the rule set used, the pieces and edges named |
| **False result** | reporting Normal because the cloth stretched to fit. On a woven this is physically wrong and must be caught by the fabric category, not by the drape looking acceptable |

---

#### VM-03 · Loose chest

| | |
|---|---|
| **Starting conditions** | as VM-01, considerably more room than the stated fit implies |
| **Readiness** | Ready |
| **Simulation** | Completes |
| **Message** | Chest **Worth a look** — "more room than a regular fit usually has; a relaxed fit may be intended" |
| **Evidence** | the numbers and the stated intended fit |
| **False result** | calling it Needs attention. Loose is a design choice far more often than it is a fault, and a red finding on an intended relaxed fit trains people to dismiss red findings |

---

#### VM-04 · Large stomach

| | |
|---|---|
| **Starting conditions** | body with a stomach girth larger than its chest; garment cut straight |
| **Readiness** | Ready |
| **Simulation** | Completes. Strain concentrated at the waist, chest comfortable |
| **Message** | Stomach **Needs attention** or **Worth a look**; Chest Normal. The two must be reported separately |
| **Evidence** | both readings, and the height each was taken at |
| **False result** | averaging the torso into one verdict. "Chest fine, stomach tight" is the finding; a single body reading hides it |

---

#### VM-05 · Wide shoulder

| | |
|---|---|
| **Starting conditions** | body shoulder wider than the pattern's shoulder |
| **Readiness** | Ready |
| **Simulation** | Completes. The shoulder seam is pulled inboard of the shoulder point |
| **Message** | Shoulder **Needs attention** — the seam sits inside the shoulder point and the back is strained |
| **Evidence** | seam end position, body shoulder point, both sides separately |
| **False result** | reporting only one side. Bodies and drapes are not perfectly symmetric; each shoulder is measured and reported on its own |

---

#### VM-06 · Narrow shoulder

| | |
|---|---|
| **Starting conditions** | body shoulder narrower than the pattern's |
| **Readiness** | Ready |
| **Simulation** | Completes. The seam falls outside the shoulder point |
| **Message** | Shoulder **Worth a look** — "falls past the shoulder point; correct for a dropped shoulder, check it is intended" |
| **Evidence** | as VM-05 |
| **False result** | calling a deliberate dropped shoulder a defect. Category and intended fit decide; on a relaxed tee this is Normal |

---

#### VM-07 · Large bicep

| | |
|---|---|
| **Starting conditions** | body upper arm larger than the sleeve allows |
| **Readiness** | Ready |
| **Simulation** | Completes, sleeve strained |
| **Message** | Bicep **Needs attention**; Armhole likely **Worth a look** as well |
| **Evidence** | sleeve girth, body girth, the armhole reading alongside |
| **False result** | reporting the bicep alone. Sleeve width and armhole are one problem, and fixing the sleeve without the armhole breaks the cap seam |

---

#### VM-08 · Short sleeve

| | |
|---|---|
| **Starting conditions** | long-sleeved garment whose sleeve does not reach the wrist |
| **Readiness** | Ready |
| **Simulation** | Completes |
| **Message** | Sleeve length **Worth a look** or **Needs attention**, with the shortfall and the pose caveat |
| **Evidence** | sleeve end position, wrist landmark, the pose used |
| **False result** | reporting a short-sleeved garment as a short sleeve. The template knows which this is; a short-sleeve style gets the position reported and no verdict |

---

### Group B — the mapping is wrong

These must be **refused**. Every one of them produces a plausible garment if
allowed to run.

---

#### VM-09 · Missing seam pairing

| | |
|---|---|
| **Starting conditions** | a required seam for the template has no mapping; the edges exist and are not declared finished |
| **Readiness** | **Refused** — R4 |
| **Simulation** | does not start |
| **Message** | "This garment cannot be fitted yet: the side seam has not been mapped. Pair the front and back side edges, or mark them as finished edges." — names the pieces |
| **Evidence** | the mapping as it stands, with the gap named |
| **False result** | **running with an open seam.** The garment drapes as a flat sheet hanging off the shoulders, looks like loose cloth, and every girth reading is enormous. Nothing about it says "unsewn" |

---

#### VM-10 · Reversed seam direction

| | |
|---|---|
| **Starting conditions** | a seam mapped with its alignment the wrong way round — A-start sewn to B-end where it should be B-start |
| **Readiness** | **Refused**, where it can be detected — a reversal usually makes the seam cross itself or places the two runs' endpoints implausibly far apart |
| **Simulation** | does not start when detected. Where it cannot be detected before running, the geometry check after assembly must catch the twist and **fail** |
| **Message** | "The sleeve appears to be sewn in back to front. Check which end of the sleeve cap meets the front of the armhole." |
| **Evidence** | the alignment as mapped, the endpoint distances that gave it away |
| **False result** | **the worst case in this document.** A reversed sleeve drapes, renders and looks very nearly right. The twist reads as a drape fold. Nobody catches it by eye, and the fitting is confidently wrong |

---

#### VM-11 · Seam-length mismatch

| | |
|---|---|
| **Starting conditions** | two edges mapped to each other whose lengths differ by more than the template's ease allowance |
| **Readiness** | **Refused** — R5 |
| **Simulation** | does not start |
| **Message** | "These two edges do not fit each other: the sleeve cap is 42 mm longer than the armhole it is sewn to, and this seam allows up to 15 mm of easing. Check the pairing, or check the pattern." |
| **Evidence** | both lengths, the allowance, the seam |
| **False result** | **easing it in silently.** A solver will happily gather 42 mm into a shorter edge and produce a puckered but complete garment. The pattern error disappears into the drape, and the fitting says the garment is fine |

---

### Group C — the pattern or its units are wrong

---

#### VM-12 · Unknown scale

| | |
|---|---|
| **Starting conditions** | pattern whose stated scale cannot be confirmed against its geometry — for example a file whose declared extents are a placeholder |
| **Readiness** | **Refused** |
| **Simulation** | does not start |
| **Message** | "The size of this pattern could not be confirmed. Every measurement would be a guess." |
| **Evidence** | what the file declared, what the geometry actually spans, and the difference |
| **False result** | trusting a declared extent. Our own CLO exports declare extents of 1000×1000 while the geometry spans about 52 units — the header is a placeholder. A pipeline that believed it would scale the garment by roughly twenty times |

---

#### VM-13 · Wrong units

| | |
|---|---|
| **Starting conditions** | pattern drawn in inches, imported as millimetres — or no unit stated at all |
| **Readiness** | **Refused** where no unit is stated. Where a unit is stated but implausible, **refused** on the plausibility check |
| **Simulation** | does not start |
| **Message** | "This pattern states no unit, so its size is unknown." / "At the stated unit, the largest piece is 25 mm across. That is not a garment piece — check the unit." |
| **Evidence** | the stated unit, its source, and the largest piece's size at that unit |
| **False result** | **a 25.4× error with no symptom.** The garment drapes perfectly; every proportion is right; every absolute number is wrong. The Fit Assistant compares it against a real body and reports nonsense with high confidence. This is the reason the unit is refused rather than assumed |

---

#### VM-14 · Open piece

| | |
|---|---|
| **Starting conditions** | a piece whose outline does not close |
| **Readiness** | **Refused** — R6 |
| **Simulation** | does not start |
| **Message** | "One pattern piece is not closed, so it cannot be made into cloth. The outline starts and ends 14 mm apart." — names the piece |
| **Evidence** | the piece, the gap size and where it is |
| **False result** | closing it automatically. A 14 mm gap may be a rounding artefact or a missing segment, and the two need different fixes. Closing it quietly turns a pattern error into a slightly wrong garment |

---

#### VM-15 · Self-intersecting piece

| | |
|---|---|
| **Starting conditions** | an outline that crosses itself |
| **Readiness** | **Refused** — R6 |
| **Simulation** | does not start |
| **Message** | "One pattern piece crosses over itself and cannot be made into cloth." — names the piece and where |
| **Evidence** | the piece and the crossing location |
| **False result** | letting it reach the mesh builder. A self-intersecting outline either fails there with an unreadable error, or produces folded-over cloth that behaves erratically and takes the whole fitting with it |

---

#### VM-16 · Missing grainline

| | |
|---|---|
| **Starting conditions** | a simulated piece with no grainline, on a fabric whose lengthwise and crosswise behaviour differ meaningfully |
| **Readiness** | **Refused** — R8. Where warp and weft are within a small margin of each other, **Ran, qualified** instead |
| **Simulation** | does not start when refused |
| **Message** | "This piece does not say which way the grain runs, and this fabric behaves differently along and across. The fitting would be of a fabric nobody specified." |
| **Evidence** | the piece, the fabric's warp and weft values |
| **False result** | **assuming vertical.** It is the most common grain and it is wrong often enough to matter — a neck band is cut across the grain precisely so it stretches, and simulating it along the grain produces a band that will not go over a head |

---

#### VM-17 · Woven fabric using knit properties

| | |
|---|---|
| **Starting conditions** | a woven garment whose fabric profile carries knit stretch values — by a wrong preset, a copied profile or a category left unset |
| **Readiness** | **Refused** where the category and the values contradict each other. Where no category is stated, **Refused** for the missing category |
| **Simulation** | does not start |
| **Message** | "This fabric is marked as a woven but stretches like a knit. Check the fabric profile before fitting." |
| **Evidence** | the profile, its source and confidence, and which values triggered it |
| **False result** | **everything looks fine.** Excess stretch hides every tight place: the chest gives, the armhole gives, the bicep gives, and all nine findings come back Normal on a garment that would not go on. This is the quietest failure in the document and the reason category is a required field |

---

#### VM-18 · Stale fitting after a pattern revision

| | |
|---|---|
| **Starting conditions** | a fitting exists; a newer pattern revision is approved afterwards |
| **Readiness** | the existing fitting becomes **stale**. It is not deleted and not silently re-pointed |
| **Simulation** | nothing re-runs by itself |
| **Message** | on the old fitting: "This fitting was made from pattern revision 4. Revision 5 has since been approved. Re-run it to see the current pattern." |
| **Evidence** | the fitting keeps its own revision reference for ever |
| **False result** | **re-pointing it at the new revision.** The drape, the findings and the numbers would all belong to the old pattern while the screen named the new one. Every number would be wrong and nothing would look wrong. A stale fitting that says so is useful; a silently updated one is a lie |

---

## 3. Summary

| # | Case | Readiness | Simulation |
|---|---|---|---|
| 01 | Normal fit | Ready | Runs, all Normal |
| 02 | Tight chest | Ready | Runs, Needs attention |
| 03 | Loose chest | Ready | Runs, Worth a look |
| 04 | Large stomach | Ready | Runs, separate readings |
| 05 | Wide shoulder | Ready | Runs, per side |
| 06 | Narrow shoulder | Ready | Runs, Worth a look |
| 07 | Large bicep | Ready | Runs, with armhole |
| 08 | Short sleeve | Ready | Runs, pose caveat |
| 09 | Missing seam pairing | **Refused** | — |
| 10 | Reversed seam direction | **Refused** / fails the geometry check | — |
| 11 | Seam-length mismatch | **Refused** | — |
| 12 | Unknown scale | **Refused** | — |
| 13 | Wrong units | **Refused** | — |
| 14 | Open piece | **Refused** | — |
| 15 | Self-intersecting piece | **Refused** | — |
| 16 | Missing grainline | **Refused** (or qualified if warp ≈ weft) | — |
| 17 | Woven using knit properties | **Refused** | — |
| 18 | Stale after revision | **Stale**, kept | nothing automatic |

Ten of eighteen are refusals. That ratio is deliberate: the cases that produce a
convincing, wrong garment outnumber the ones that produce an obviously broken
one, and the only defence against a convincing wrong garment is refusing to
make it.

---

## 4. What this pack does not cover yet

Stated so nobody reads its silence as approval.

- **Movement.** Every case is a static pose. Whether a sleeve binds when the arm
  lifts is not tested, and the armhole finding says so.
- **Multi-layer garments.** Interlinings and linings are excluded from the
  drape.
- **Graded sizes.** Each case is one size. Whether a mapping still holds across
  a size range is a later pack.
- **Fabric behaviour over time.** Relaxation, shrinkage after washing, and bias
  growth under wear are out of scope.
- **Comparison against a real sample.** The strongest validation available —
  fit the pattern, make the sample, measure both — needs a made garment and
  belongs in a later phase.
