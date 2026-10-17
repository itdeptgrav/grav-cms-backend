# CCTV active-phone-use evidence cascade

Status: accepted for implementation as a non-production shadow pilot.  
Date: 13 October 2026.

## Decision

Active phone use is decided by a multi-level evidence cascade. No person
detector, phone detector, pose estimator, action recogniser, vision-language
model, or individual threshold is allowed to declare the final event by itself.

The cascade is:

```text
read-only camera/video input
  -> frame-quality and resolvability gate
  -> anonymous person detector + tracker
  -> phone-object proposal ensemble
  -> pose/hand/ear ownership geometry
  -> temporal action evidence
  -> candidate-window builder
  -> bounded semantic verifier for ambiguous/candidate windows only
  -> calibrated three-way fusion: ACTIVE | NOT_ACTIVE | UNCERTAIN
  -> temporal event state machine
  -> optional, separately authorised identity resolution
  -> human-reviewable GRAV event
```

The first implementation remains outside the monolithic CMS process. It runs
as an isolated vision worker and publishes typed, company-scoped event evidence
through the existing CCTV event boundary.

## Why a cascade is required

The October 2026 evaluation demonstrates complementary model strengths and
failure modes:

- person detection/tracking supplies geometry and continuity but no activity;
- phone detectors localise phone-like objects but confuse unattended phones and
  non-phone hand objects with active use;
- pose supplies wrist/ear/body relationships but cannot identify the held
  object or infer intent;
- temporal action models recognise movement patterns but confuse cups, pens,
  remotes and nearby phones;
- Qwen3-VL 8B rejected all six hard negatives in the untouched 12-clip clear-video
  set but detected only four of six active-use positives;
- adding enlarged person crops did not recover the two Qwen3-VL misses;
- the earlier handcrafted fusion scored 8/12 on the same untouched set after
  scoring 30/30 on its development clips, proving that manual rule stacking
  overfit.

Measured results are baselines, not production claims:

| Run | Set | Correct | Precision | Recall | Interpretation |
| --- | --- | ---: | ---: | ---: | --- |
| handcrafted v1 | 30 fresh stock clips | 26/30 | 92.3% | 80.0% | useful baseline |
| handcrafted v2 | 12 untouched clear clips | 8/12 | not accepted | not accepted | overfit |
| Qwen3-VL 8B | same 12 untouched clear clips | 10/12 | 100% | 66.7% | strong negative verifier, insufficient recall |
| Qwen3-VL 8B + person details | diagnostic reuse of those 12 clips | 10/12 | 100% | 66.7% | no improvement; not a new validation |

## Layer contracts

### L0 — quality and resolvability

Before classification, record blur, exposure, person-box size, crop resolution,
occlusion and estimated phone-pixel size. A window that cannot visibly support
the claim is `UNCERTAIN`; later models may not manufacture certainty.

### L1 — anonymous detection and tracking

YOLO supplies person boxes and ByteTrack/BoT-SORT supplies session-local track
continuity. This layer emits geometry, timestamps and track-quality signals
only. It does not emit activity or employee identity.

### L2 — phone proposals

The project-specific phone checkpoints, the COCO phone class and an optional
open-vocabulary detector may each propose phone regions. Their outputs are
deduplicated and retained as separate features. Presence is never equivalent to
use, and a phone lying on a desk is a negative example for the final task.

### L3 — ownership geometry

YOLO11x Pose supplies wrist, elbow, shoulder, eye and ear keypoints. This layer
computes phone-to-wrist, phone-to-ear, phone-inside-person, hand-object contact,
proposal persistence and proposal/hand motion coupling. It may rank which
person owns a proposal; it may not label phone use.

### L4 — temporal action evidence

A video action model evaluates a bounded four-to-six-second person window. It
emits class logits such as phone call, texting, typing, writing, drinking and
remote use. Raw logits are retained; top-1 text is not treated as truth.

### L5 — semantic verification

The production worker has a hard 12 GB VRAM ceiling. Qwen3-VL 8B in BF16 is
therefore an offline teacher/evaluation model, not the production default. The
deployed semantic verifier is selected by a frozen quality/latency/memory
bake-off. The initial candidate is Qwen2.5-VL 3B or another verifier that meets
the same schema; a quantized 8B model is eligible only if measured peak memory,
latency and accuracy all pass the deployment gates.

The verifier receives a bounded evidence packet only when earlier layers
produce a candidate or conflicting evidence. The packet contains chronological
overview frames, person details, hand/ear details and marked phone proposals.
It answers a versioned schema:

```json
{
  "phone_visible": "YES | NO | UNCERTAIN",
  "owned_by_target": "YES | NO | UNCERTAIN",
  "active_interaction": "YES | NO | UNCERTAIN",
  "mode": "HANDHELD_VIEW | TAPPING | CALL_AT_EAR | NONE | UNCERTAIN"
}
```

Free-form prose is diagnostic only. Invalid, late or out-of-schema responses
become `UNCERTAIN`.

### L6 — calibrated fusion

The final per-window decision comes from a small calibrated classifier trained
on labelled evidence features. The initial candidate is logistic regression or
gradient-boosted trees with probability calibration and grouped cross-validation
by source video/camera. The feature set includes quality, detector, pose,
temporal and verifier outputs plus missingness flags.

Training, calibration and threshold selection use development data only. The
fusion model and thresholds are frozen before every holdout run. A three-way
policy maps calibrated probability to `ACTIVE`, `NOT_ACTIVE` or `UNCERTAIN`;
there is no default-positive fallback.

### L7 — temporal events

Window decisions feed a replayable state machine. The provisional policy is:

- open an event after at least two supporting complete windows;
- preserve raw window evidence even when smoothing changes the displayed state;
- close an event after configured contradictory or missing windows;
- merge short gaps without double-counting duration;
- report the decision delay and event-duration error;
- bound work to one current candidate per camera/track and discard stale work.

Values remain configuration, not source-code constants, and must be calibrated
on development data before an untouched camera-matched holdout.

### L8 — identity is separate

If explicitly authorised, an existing biometric/person-recognition service may
map a stable anonymous event to an employee after activity classification. The
activity models never receive the person's name, role or employment history.
Unresolved identity remains an anonymous track. Identity confidence and
activity confidence are stored separately and neither substitutes for the
other.

## Evidence envelope

Every evaluated window records enough information to reproduce the decision:

```json
{
  "cameraRef": "camera-reference",
  "trackId": 8,
  "windowStart": "ISO-8601",
  "windowEnd": "ISO-8601",
  "quality": {},
  "personTrack": {},
  "phoneProposals": [],
  "poseFeatures": {},
  "actionLogits": {},
  "vlmVerdict": null,
  "fusion": {
    "activeProbability": 0.0,
    "decision": "UNCERTAIN",
    "reasonCodes": []
  },
  "versions": {
    "pipeline": "phone-use-cascade-v1",
    "detectors": [],
    "pose": null,
    "action": null,
    "vlm": null,
    "fusion": null,
    "temporalPolicy": null
  }
}
```

## Evaluation and adoption gates

The clear-stock set and supplied hard CCTV clip are now development evidence.
They may diagnose the pipeline but may not be reused as the final holdout.

Before any production claim:

1. label camera-matched data at the event level, including phones lying nearby,
   cups, pens, remotes, laptop use, occlusion, calls and two-handed texting;
2. split by source video/day, never by adjacent frames;
3. freeze every model revision, prompt, feature transform and threshold;
4. run an untouched holdout containing at least 100 active-use events and 200
   hard-negative events across representative camera conditions;
5. achieve event-level precision of at least 98%, recall of at least 90%, and
   report the uncertainty/coverage rate separately;
6. report results per camera, distance band, phone-pixel band and activity mode;
7. measure ID switches, duplicate events, duration error and end-to-end latency;
8. retain a human-review path and prohibit automatic disciplinary action.

If the gate is missed, the output remains a review candidate, not an employee
fact.

## Runtime profile

Person tracking and proposal generation run continuously on sampled frames.
Pose and temporal action inference run per active track at a lower cadence.
The semantic verifier runs only for candidate/conflict windows, preserving GPU
capacity. Person boxes may update in real time; a reliable activity event is
expected to lag by approximately four to eight seconds.

### 12 GB VRAM deployment budget

The worker must run on a GPU with 12 GB VRAM. It uses one bounded inference
scheduler rather than keeping every heavy model active simultaneously:

- reserve at least 1 GB for CUDA/runtime fragmentation and safety margin;
- keep only the real-time person detector/tracker resident continuously;
- execute phone proposal and pose passes at their configured lower cadence;
- execute the temporal action model in bounded batches;
- invoke the semantic verifier only after a candidate is formed;
- keep decoded frames, ring buffers, feature tables, fusion and event state in
  system RAM, not VRAM;
- unload or CPU-offload mutually exclusive heavy stages when profiling proves
  they cannot safely coexist.

The accepted deployment must remain below 11.5 GB measured peak allocated plus
reserved CUDA memory during a worst-case multi-person replay. An out-of-memory
recovery path may drop stale candidate work and emit `UNCERTAIN`; it may never
restart with a lower-quality unversioned model silently.

The offline 8B teacher may generate development labels or adjudication evidence
on the current A40, but teacher output is never treated as ground truth and the
deployed 12 GB result must be evaluated independently.

## Supersession

This decision specialises `cctv-hybrid-event-architecture.md` for active phone
use and supersedes camera-specific rules and direct model-to-label paths in the
historical experiments. It does not activate employee identity, production
alerts or employment actions.

