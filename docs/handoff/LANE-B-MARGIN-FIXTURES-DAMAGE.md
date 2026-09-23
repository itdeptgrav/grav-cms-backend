# LANE A DAMAGED THREE LANE B TEST FILES — WHAT WAS CHANGED (8 Sep 2026)

Lane A ran a bulk regex over `test/costing/*.test.js` to strip the margin-band
fields Lane B's migration had just retired from costing-policy PUT bodies. It
matched three files that are **Lane B's own new suites**, where those fields are
not stale fixture config but the assertions themselves.

The three files are **untracked**, so there is no git baseline to restore from.
Lane A has stopped touching them. The values below marked **GUESSED** were
inferred from each test's name and intent and may not be what Lane B wrote.

## The regex

```
\n[ \t]*(minimumMarginPercent|targetMarginPercent|preferredMarginPercent
        |approvalThresholdMarginPercent|estimatedIncomeTaxRatePercent): "[^"]*",
```

It deleted whole lines of that shape, wherever they appeared.

## `test/costing/board-contingency-costing.test.js`

**No occurrences of the matched keys remain and none were restored.** If the
file originally contained any of the five fields, those lines are gone and are
not recorded here — Lane A did not capture the file before editing. The suite
was passing before and should be re-checked against Lane B's own copy.

## `test/costing/board-margin-policy.test.js` — 22/22 passing, 4 lines rebuilt

| Site | Restored as | Confidence |
|---|---|---|
| `const BAND = {…}` (line ~46) | `minimumMarginPercent: "18"` | **Certain** — 18/25/32 is the fixture band used across the folder |
| `publish(me, co, {…})` in *"an approved band of nil IS applied"* | `minimumMarginPercent: "0"` | **Certain** — the test is about an all-nil band |
| `publish(me, co, {…})` in *"equal figures are a valid band — the rule is ≤, not <"* | `minimumMarginPercent: "25"` | **Certain** — the test requires all three equal |
| `publish(me, co, {…})` in *"the ordering is compared numerically, so 9 and 10 do not swap"* | `minimumMarginPercent: "9"` | **GUESSED** — 9 is what makes the 9-vs-10 comparison the test names, but the original may have differed |
| `withLegacy(co, {…})` in *"the schema's all-zero DEFAULT is not offered"* | `minimumMarginPercent: "0"` | **Certain** — the test is about 0/0/0 |
| `overlayFor` expectation (line ~169) | `minimumMarginPercent: "18"` | **Certain** — asserts the band published above |

Other `overlayFor`/expectation objects were repaired by a blanket
`minimumMarginPercent: "18"` insertion before `targetMarginPercent: "25"`.
**Any site where the intended minimum was not 18 is now wrong and green**,
which is the dangerous case.

## `test/costing/board-margin-costing.test.js` — STILL FAILING, 4 lines rebuilt

| Site | Restored as | Confidence |
|---|---|---|
| `approveMarginPolicy(w.co._id, {…})` nil-band sites (×2) | `minimumMarginPercent: "0"` | **Certain** |
| `approveMarginPolicy(w.co._id, { … "30" / "40" })` | `minimumMarginPercent: "22"` | **GUESSED** |
| `approveMarginPolicy(w.co._id, { … "45" / "50" })` | `minimumMarginPercent: "40"` | **GUESSED** |
| frozen-provenance expectation (line ~199) | `minimumMarginPercent: "18"` | **Likely** |

Still red at the time of writing:

* *"prices are solved from the approved band, exactly as before › cost / (1 - margin), not cost + markup"*
* *"prices are solved from the approved band, exactly as before › an approved band of nil prices at cost"*

Both are price-solving assertions, so the surviving failures are consistent
with at least one guessed minimum being wrong.

## Recommended recovery

Restore all three files from Lane B's own working copy or editor history rather
than from these reconstructions. Treat every **GUESSED** row above as
untrustworthy even where the suite is now green.
