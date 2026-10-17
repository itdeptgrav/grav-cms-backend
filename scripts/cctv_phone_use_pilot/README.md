# CCTV active-phone-use review dataset

This package creates the labelled evidence boundary required before training
the calibrated active-use classifier. It does **not** treat detector, action
model or VLM output as ground truth.

## Mutually exclusive human labels

- `NO_PHONE`: no phone can be resolved for the target.
- `PHONE_VISIBLE`: a phone is visible nearby, but ownership/holding is not
  established.
- `PHONE_HELD`: the target holds or owns the phone, but active viewing, typing
  or calling is not established.
- `NOT_ACTIVE_UNSPECIFIED`: active use is visibly absent, but the exact
  no-phone/visible/held subtype cannot be resolved for the whole window.
- `ACTIVE_VIEW_OR_TYPE`: sustained viewing, tapping, scrolling or typing.
- `ACTIVE_CALL`: phone-to-ear or otherwise visually supported active call.
- `ACTIVE_USE_UNSPECIFIED`: active use is clear but the exact interaction mode
  cannot be resolved reliably.
- `UNCERTAIN`: the pixels or behaviour do not support a reliable decision.

The ordered states are descriptive, not a rule-based scoring ladder. Reviewers
must use the strongest state visibly supported by the complete window.

## Build a queue from an inference report

```bash
python3 -m scripts.cctv_phone_use_pilot.build_review_queue \
  /path/to/inference-report.json \
  --output /path/to/review-queue.jsonl \
  --clip-id cam20-2026-08-27-194758 \
  --source-group camera-20-2026-08-27 \
  --camera-ref camera-20 \
  --captured-date 2026-08-27 \
  --source-sha256 30e71f0d8552feb99c81d474fe772ccd1923b7a13419688ff08b4eac8eccdd22 \
  --window-seconds 4 \
  --candidate-only
```

Every generated item is `PENDING`. `modelSuggestion` is prioritisation evidence
only; it never populates `review.label`.

After review, validate the complete JSONL file:

```bash
python3 -m scripts.cctv_phone_use_pilot.annotation_schema review-queue.jsonl
```

Review decisions are stored separately from the generated queue and merged by
exact `annotationId`. This preserves the original model suggestion for later
error analysis:

```bash
python3 -m scripts.cctv_phone_use_pilot.apply_reviews \
  review-queue.jsonl decisions.json \
  --output labelled-review.jsonl \
  --require-complete
```

When one decisions document covers several clips, add an explicit
`--decision-prefix <clip-id>-` while applying it to each per-clip queue.

The merge fails closed on duplicate or unknown IDs, invalid evidence values,
incomplete reviews, or an attempt to overwrite the input queue.

## Independent adjudication

Create a round-two queue that hides the first label, its evidence and the model
suggestion:

```bash
python3 -m scripts.cctv_phone_use_pilot.adjudication blind \
  labelled-review.jsonl --output second-review.jsonl
```

After a different reviewer labels that queue, compare both complete reviews:

```bash
python3 -m scripts.cctv_phone_use_pilot.adjudication compare \
  labelled-review.jsonl second-review-labelled.jsonl \
  --output review-comparison.json
```

Comparison fails if reviewer IDs are the same, immutable window fields differ,
or either dataset is incomplete. Exact state disagreements and disagreements
about the active/not-active boundary are reported separately.

Validation fails on invalid states, incomplete reviewer attribution, exact
window conflicts, duplicate IDs, or any source group appearing in more than one
of `DEVELOPMENT`, `CALIBRATION`, and `HOLDOUT`.

Keep all clips from the same camera/day or recording session in one source
group. Adjacent frames must never be split across development and holdout.

