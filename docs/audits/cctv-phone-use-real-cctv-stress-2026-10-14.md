# CCTV phone-use cascade — real-CCTV stress replay

Date: 14 October 2026  
Scope: adversarial replay of the experimental fused preview; not a production
acceptance result.

## Verdict

The preview is operationally stable on the tested GPU, but it is **not yet a
reliable active-phone-use classifier**. Temporal voting reduces frame-to-frame
flicker and rejects many isolated phone proposals, but the current decision
rule still conflates a phone being visible or held with a person actively using
it.

The most important observed failure was a sustained `ACTIVE` result for Cam 20
track 3 while the person was at times merely holding a phone and at times not
visibly holding it. The red-shirt phone user in the same clip was correctly
labelled. This is a semantic interaction failure, not a threshold-only issue.

## Replays

| Clip | Video processed | Wall time | Peak reserved VRAM | Outcome |
| --- | ---: | ---: | ---: | --- |
| `cam20_2026-08-27_194758.avi` | 47.69 s | 135.1 s | 8.62 GiB | One correct sustained user and one sustained false active-use track |
| `cam09_2026-08-27_194700.avi` | 34.40 s | 101.7 s | 8.64 GiB | Two sustained candidate tracks; visual evidence includes ambiguous held objects and non-interaction periods, so not acceptable as certain active use |
| `cam09_2026-08-28_200533.avi` | 46.17 s decoded | 123.2 s | 8.59 GiB | Negative control: zero `ACTIVE` results across 135 person-time samples |

### Degraded CCTV pair

To test robustness rather than only replay the source quality, a positive and a
negative segment were converted to 854x480 at 12 fps, darkened, mildly blurred
and H.264-compressed at CRF 32.

| Test | Video processed | Wall time | Peak reserved VRAM | Outcome |
| --- | ---: | ---: | ---: | --- |
| Degraded Cam 20 positive | 21.92 s | 34.1 s | 8.62 GiB | Failed: the known non-active holder track stayed `ACTIVE` from 12-21 s, while the genuine red-shirt interaction track never reached `ACTIVE` |
| Degraded Cam 09 negative | 21.92 s | 29.6 s | 8.59 GiB | Passed: zero `ACTIVE` results across 48 person-time samples despite nine object-positive and nineteen temporal-positive samples |

The paired result is decisive for the current rule: specificity on the selected
negative is useful, but positive-scene degradation produces both a false
positive and a false negative. The model is therefore not robust to ordinary
low-resolution/compressed CCTV conditions.

The negative-control run contained 41 per-model object-positive samples. The
fusion gate suppressed all of them from becoming `ACTIVE`, demonstrating useful
hard-negative rejection. That does not offset the Cam 20 false event.

The third AVI also emitted HEVC missing-reference/RPS errors and decoded only
46.17 seconds of a nominal 53.81-second file. Input recovery/transcoding must be
part of the ingestion contract; an incomplete decode must not be reported as a
complete evaluation.

## Performance consequence

Inference took roughly 2.7-3.0 seconds of wall time per second of video, after
model loading. Memory fits inside the 11.5 GiB engineering ceiling, but this
implementation is not real-time and cannot serve twenty cameras on one 12 GB
GPU.

## Root cause

The preview combines person tracking, two phone proposal models, pose hints,
AVA features, Qwen frame verification and temporal hysteresis. The dominant
positive evidence is still object presence plus a semantic phone confirmation.
Neither is sufficient to prove interaction. Hysteresis then makes a mistaken
positive look stable.

The output ontology is also too coarse: `ACTIVE` versus `NO PHONE` forces
visible, carried and ambiguous phones into the same path as actual interaction.

## Required next implementation slice

Do not tune the existing final threshold against these clips. Continue the
planned evidence architecture instead:

1. Split labels into `NO_PHONE`, `PHONE_VISIBLE`, `PHONE_HELD`,
   `NOT_ACTIVE_UNSPECIFIED`, `ACTIVE_VIEW_OR_TYPE`, `ACTIVE_CALL`,
   `ACTIVE_USE_UNSPECIFIED` and `UNCERTAIN`.
2. Make `ACTIVE_*` require temporal interaction evidence: device ownership,
   hand-device coupling, gaze/head orientation, device-to-ear geometry, and
   either repeated manipulation or a sustained call pose.
3. Feed the verifier a chronological multi-frame packet or short person clip;
   a single crop can confirm an object but cannot reliably prove activity.
4. Train/calibrate fusion on labelled camera-matched windows with held-phone,
   cup, bottle, remote, pen, desk-phone and phone-on-table hard negatives.
5. Report event-level precision/recall and an explicit uncertainty rate on a
   frozen holdout. Do not promote the preview to employee analytics before the
   PU-10 gates pass.

JEV is not a pixel/video classifier and does not repair this evidence gap. It
may classify or route the structured event only after the vision pipeline has
produced a calibrated result.

## RunPod evidence

- `/workspace/phone_detc_pilot/stress_tests/cam20-fused.log`
- `/workspace/phone_detc_pilot/stress_tests/cam09-194700-fused.log`
- `/workspace/phone_detc_pilot/stress_tests/cam09-200533-negative.log`

These are supporting artefacts on replaceable compute; this document is the
durable verdict.

## Review-data implementation

The follow-up implementation is in `scripts/cctv_phone_use_pilot`. It provides:

- a versioned, fail-closed JSONL annotation contract;
- a strict separation between `modelSuggestion` and human `review.label`;
- four-second review-window generation from JSON reports or noisy worker logs;
- grouped-split leakage, duplicate, conflict, timestamp and reviewer checks;
- SHA-256 fields for the exact source clip.

The exact local source hashes are:

| Clip | SHA-256 |
| --- | --- |
| `cam20_2026-08-27_194758.avi` | `30e71f0d8552feb99c81d474fe772ccd1923b7a13419688ff08b4eac8eccdd22` |
| `cam09_2026-08-28_200533.avi` | `ba741cf4307f4483c174a5148e5f12ad5a8dfb32cc64b17537eb3731d7f5d78b` |

Conversion of the preserved RunPod logs produced nine Cam 20 candidate windows
and 28 Cam 09 negative-control windows. A Codex visual audit reviewed four
chronological full-scene frames plus expanded target crops for each window. It
was recorded as development evidence with reviewer identity, timestamp and
confidence; model suggestions remained unchanged and were never promoted into
review labels.

| Source | Model suggestion | Visual-review distribution |
| --- | --- | --- |
| Cam 20 | 9 `ACTIVE` | 1 `ACTIVE_VIEW_OR_TYPE`, 4 `PHONE_HELD`, 1 `NOT_ACTIVE_UNSPECIFIED`, 3 `UNCERTAIN` |
| Cam 09 negative | 28 `NOT_ACTIVE` | 28 `NOT_ACTIVE_UNSPECIFIED` |

This quantifies the semantic failure: only one of nine candidate windows has
visual support for active viewing, while four show only a held phone. The
reviewed datasets are:

- `docs/audits/evidence/cam20-review-labelled-2026-10-14.jsonl` — canonical
  dataset SHA-256
  `0753cb8817bd74a892597c8514455a45259a3ac362e113b9ca1a61aa74fadb1d`
- `docs/audits/evidence/cam09-negative-labelled-2026-10-14.jsonl` — canonical
  dataset SHA-256
  `65019bb73fe89ca8959a56dcadc9e3655f070305b126266430fae947bcbcf09a`
- `docs/audits/evidence/cctv-phone-use-visual-decisions-2026-10-14.json` —
  attributable source decisions used to produce both JSONL files

Blinded second-review queues are also frozen:

- `docs/audits/evidence/cam20-round2-blinded-2026-10-14.jsonl` — 9 pending,
  canonical dataset SHA-256
  `0ae1cdea8302fb799a62a69347d96ce6c893979af06ffb70c066c2b8b63a0079`
- `docs/audits/evidence/cam09-negative-round2-blinded-2026-10-14.jsonl` — 28
  pending, canonical dataset SHA-256
  `4ba05a24888c510d627bdc6e06d82c7cae77b0a4855ade521d6ed1d99245d272`

These queues remove the first label, review evidence and model suggestion. A
different reviewer must complete them before the comparison command will run.

These are provisional development labels, not final human ground truth. The
Cam 09 source also had HEVC decode loss, reflected in reduced confidence on
terminal windows. The next honest gate is independent human adjudication and
more camera-matched positive and hard-negative source groups. Thirty-seven
windows from two inspected sources are too small and imbalanced to train or
claim a reliable classifier.
