# Fit analysis schemas

**Lane B · data design · 3 Oct 2026. Schema version 1.**
Seven record shapes, the validators that enforce them, and a short reason for
each rule that looks arbitrary.

**This document and [`fit-tools.md`](./fit-tools.md) are authoritative about what
these shapes mean**; `components/rnd/fitTools/schema.js` in the frontend repo —
with `metrics.js` for units, `evidence.js` for statement classes and `bands.js`
for thresholds — **enforces** them. Where the two disagree, one of them is
defective: surface it, correct the product document first if the rule itself is
wrong, and change the code to match. Neither side silently wins.

Every validator is a pure function returning an array of plain-language problems —
empty means valid. They return sentences rather than codes because the sentences
are shown to a person.

Nothing here is persisted yet. These shapes exist so the UI, the tests and the
eventual Lane A output agree before any of it is written to a database.

---

## 1. Provenance

Carried by every analysis. `provenanceProblems()` requires all of:

| Field | Why it is required |
|---|---|
| `jobRef` | Which render produced this |
| `patternRevisionRef` | Which revision was draped — **not** whichever is selected now |
| `patternRevisionNumber` | For the comparison label |
| `solverVersion` | Two solver versions are not comparable |
| `geometryIdentity` | The mesh fingerprint; proves a reopened drape rebuilt the same mesh |
| `quality` | Mesh density moves every number |
| `bodyId`, `fabricId` | Held constant across a comparison, or the comparison means nothing |
| `bandSetId`, `bandSetVersion` | Which thresholds coloured it — **required the moment anything is judged**, and not before |
| `madeAt` | When |

A record missing any of these is not a weaker analysis, it is an unattributable
one, and the validator refuses it rather than defaulting a field.

The band-set pair is the one conditional entry. An analysis that reported numbers
without classifying them had no thresholds to cite, so requiring them
unconditionally would reject an honest record. `bandCitationProblems()` in
`bands.js` requires both as soon as any derived finding or classified zone is
present — and requires the **version** as loudly as the id, because a set
re-judged under v2 and recorded as "v?" is indistinguishable from the original.

---

## 2. Scalar fields

```
{ metric, domain, values, missing?, outOfRange?, count }
```

`domain` is `vertex` or `face` (`FIELD_DOMAIN`). `values` may be a typed array
and is **kept as one** — copying a 50,000-element `Float32Array` into a JS array
for validation would cost more than the validation.

`scalarFieldProblems(field, { expectedCount })` enforces:

- **Length must match the mesh exactly.** A field of a different length is not a
  partial reading, it belongs to a different mesh. There is no reconciliation
  rule because any reconciliation would be a guess at which vertices moved.
- **Out-of-range values are counted, not dropped.** `outOfRange` is a number on
  the record. 400 vertices at 900% strain is a fact about the solver and has to
  reach somebody.
- **`missing` is an explicit index set**, never a sentinel value. This is the
  rule that matters most:

  > A vertex with no reading is not a vertex reading zero.

  `strain()` averages the incident edges long enough to carry a ratio. A vertex
  whose every edge was excluded stays at `0.0`, which on a heatmap is a
  comfortable, slack, green armhole where in fact nothing was measured.

`fieldStats(field)` returns `{ min, max, mean, measured, missing }` and excludes
the `missing` set from all four. Including them would drag every mean toward zero
in proportion to how much of the garment was unmeasurable — the garments where
the number matters most.

---

## 3. Body zones

Twelve, in `BODY_ZONES`, each with an `id`, a `label`, the body landmark it
`needs`, and a `side` where it has one:

```
neck · shoulder.left · shoulder.right · chest · armhole.left · armhole.right
bicep.left · bicep.right · waist · hip · hem · back
```

They are coarse deliberately. A zone is the unit of comparison between
revisions, and a finer zone than the body landmarks support would produce
comparisons whose differences come from the zoning. `needs` names the landmark
so that a body built without it can declare the zone unavailable instead of
reporting a number from the wrong place.

---

## 4. Anchored findings

```
{ findingId, title, evidence, anchor,
  metric?, value?,        // solver evidence
  rule?,                  // derived interpretation
  author?,                // authored assessment
  severity?, note? }
```

`evidence` decides which optional fields are required — `findingProblems()`
checks that a derived finding names its rule and an authored one names its
author.

**Anchors are one of two kinds** (`ANCHOR_KIND`):

- `pattern-point` → `{ pieceRef, x, y }` in **pattern millimetres**
- `body-zone` → `{ zone }` from `ZONE_IDS`

**`vertexIndex` is rejected explicitly**, with its own message, rather than
merely being unsupported. Vertex indices are produced by the mesher and change
with quality, with a boundary resample, and with any solver change — a finding
pinned to one survives as a valid-looking record pointing at a different part of
the garment. The failure is silent, which is why the rejection is loud.

---

## 5. Manipulations

```
{ kind, seq, region: { pieceRef, x, y, radiusMm }, target?, strength? }
```

`kind` is `grab`, `pin` or `relax` (`MANIPULATION`). `seq` is required: order
matters, because a pin placed after a grab holds different cloth.

The region is anchored in the **piece's own coordinates with a radius in pattern
millimetres** — not a vertex list, which `manipulationProblems()` rejects by
name. A radius in pattern millimetres covers the same cloth at draft and at
normal quality; a vertex list covers whatever the mesher happened to produce.

`withheldUnder(manipulations)` returns the metric ids that may not be reported
while these are in force. The rule is not "show it greyed": a held garment has no
honest reading, and a greyed number is still a number in a screenshot.

---

## 6. Fit analysis result

```
{ schemaVersion, analysisId, provenance, settled, convergence,
  bandSetId, bandSetVersion,
  fields: { strain?, clearance?, penetration? },
  zoneSummary: [{ zone, metric, value }],
  findings: [...], warnings: [...],
  manipulations: [...], withheld: [...] }
```

`analysisProblems()` adds one requirement beyond field checks:

> An analysis with `settled: false` **must** carry the unsettled-drape warning.

Not "should". An unsettled drape with no warning on it is the single most
dangerous record this feature can produce, because it looks exactly like a
settled one and every downstream screen will treat it as a dimension.

---

## 7. Comparison records

`comparability(before, after)` → `{ comparable, blockers, cautions }`.
`compareByZone(before, after, metricId)` → rows of
`{ zone, label, from, to, delta, why? }`.

Blockers: different `solverVersion`, different `bodyId`, different `fabricId`.
Cautions: same `patternRevisionRef`, different `quality`, either drape unsettled.

A zone missing from one side produces `delta: null` and a `why`, never a delta
against an assumed zero.

**There is no per-vertex comparison function, and that is a design decision**:
two revisions mesh differently, so a per-vertex delta is a picture of the
re-meshing. Not offering it is more reliable than offering it with a warning.

---

## 8. Band sets

```
{ id, version, status,
  metric, unit,
  appliesTo: { category, fitIntent, fabricBehaviour },
  ranges: [{ level, from, to, label, colourToken }],
  effectiveFrom, retiredOn,
  author: { name, at }, approval: { approvedBy, approvedAt } | null,
  changeReason, demo? }
```

Levels, in order of severity: `slack · easy · close · tight · critical`.
`fitBandSetProblems()` in `bands.js` is the full validator; `bandSetProblems()`
in `metrics.js` checks the older cumulative `{ level, upTo }` shape that the
first fit screens were written against, and remains only for them.

**Ranges are half-open, `[from, to)`,** except the last, which closes at the
metric's maximum. This is the only arrangement in which "exactly one band for
every supported value" is true by construction rather than by trusting the
author to write the same number as one range's end and the next one's start. It
also makes the boundary answerable: at exactly 12%, the band is the one that
*starts* there.

The validator refuses, each with the offending values named:

| Refusal | Why it matters |
|---|---|
| Gap | Values somewhere in the middle of the scale get no band at all, and the table looks finished |
| Overlap | One value has two names |
| Head above the metric's floor | Strain reaches −100%; a table starting at 0 drops every compressed vertex |
| Tail below the metric's ceiling | The worst cloth on the garment falls off the end |
| Unit mismatch | Millimetres on a metric measured in percent |
| Wrong direction | **The one nothing else catches.** A clearance table in the stretch order is five plausible rows, every boundary meeting, with the colours exactly inverted. Direction comes from the metric's own `higherIsTighter`, not from the author |
| Negative range on an unsigned metric | A negative penetration depth is a different quantity, not a shallower one |
| A metric nothing produces | Bands for `pressure` or `dragLine` would be a scale over no measurement |
| Level used twice, ranges out of order | Both make a table somebody will mis-read |

**Status gates classification.** Only an `active` set, in force at the date
asked about, may judge production work; `draft` and `retired` return
`unclassified` with the reason. The editor may try a draft out explicitly, under
`PURPOSE.EXPLORATION`. Two sets in force for one garment at the same time is
reported as a data defect, never resolved by picking one.

**Approval.** An active set needs an approver and the date they approved it, and
every set needs a change reason — a threshold that moved for no recorded reason
cannot be defended to the person whose sample it rejected.

**Demo sets.** `demo: true` cannot carry an approval, and classifying against one
returns `evidence: FIXTURE`, which `countsAsFinding()` refuses. A guessed
threshold therefore cannot become something somebody cuts cloth on, however
convincing the screen around it looks.

**Colours are tokens** (`fit.band.tight`), not hex. A band set outlives a
stylesheet, and the screen decides what a token looks like in one place where
contrast is judged once.

Band sets are **data, not code**, for the same reason the C1/C2 scoring bands
live in Firestore rather than in a service: the thresholds are a business
decision that differs by category and by fabric behaviour, changes without a
deploy, and has to be quotable after the fact. A screen that coloured a garment
by a threshold nobody can name is a screen nobody should act on.

`classify(metricId, value, bandSet)` returns one of:

| Level | When | Evidence class |
|---|---|---|
| a band level | measured and judged | `derived`, carrying the rule |
| `unknown` | no value here | `warning` |
| `unclassified` | no band set for this metric | `warning` |
| `outOfRange` | outside the metric's valid range | `warning` |

Three of the four outcomes are warnings rather than judgements. That ratio is the
point: the function refuses far more often than it decides.
