# CCTV activity pilot temporal tuning

This isolated pilot code implements the local, CPU-testable portion of the
Qwen-only CCTV activity classifier. It does not connect to a camera, identify a
person, or modify the CMS application path.

## Version 2 decision flow

1. YOLO supplies a session-local track ID and expanded person crop.
2. Keep one crop per second for the same track.
3. Build a chronological 2x2 contact sheet from four seconds of crops.
4. Ask Qwen for one strict observable-activity label using
   `qwen-cctv-activity-v2-4s`.
5. Require the same window decision twice before emitting or changing a stable
   label. Hold a stable label through at most two uncertain windows.

The contact sheet remains one fixed-size image. This provides temporal evidence
without sending four full-size images and multiplying visual-token cost.

## Live behaviour

The first stable decision is delayed. At approximately 4–5 seconds, the system
can emit a label for the preceding four-second window. Until then the visible
state is `uncertain / warming_up`.

## Local verification

Run from the repository root:

```bash
python3 -m unittest discover -s scripts/cctv-activity-pilot/test -p 'test_*.py'
```

The next GPU run must replay the five explicit corrections in
`corrections.v1.json`, report each pass/fail result, and compare overall label
changes against the original Qwen-only report. Do not tune against every frame
and then describe the same frames as held-out accuracy.

The full offline runner is `run_temporal_clip.py`. On the restored CUDA host:

```bash
python run_temporal_clip.py recovered.mp4 \
  --person-model yolov8m.pt \
  --qwen-model Qwen2.5-VL-3B-Instruct \
  --output temporal-v2-results.json
```

The runner stores both raw four-second-window decisions and emitted smoothed
labels. That separation is required for diagnosing whether an error came from
Qwen or from the temporal state machine.

## Development audit set

`audit-set.v1.json` is the current comparison set for prompt and crop
experiments. It contains every detected target at fixed 0, 20, 40 and 60 second
checkpoints from the recovered cam09 clip. It is manually audited and includes
the reviewer's prior corrections, so it is a development set rather than an
untouched held-out set. Candidate variants must report exact matches against
each sample's `allowed_labels` before replacing the untouched 3B baseline.
