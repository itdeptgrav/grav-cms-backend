# OpenJev CCTV activity pilot — sequential implementation task

Status: planned; not the active `docs/tasks/current-task.md` scope.  
Source: `docs/product/openjev-cctv-activity-monitoring.md`.  
Date: 27 September 2026.

## Qwen temporal-tuning slice — evaluated on RunPod 28 September 2026

This isolated slice is authorised and was evaluated without changing the CMS
application path. The paid GPU pod was running for the evaluation and must be
stopped by the owner when review is complete because it has no attached volume.

- Versioned prompt: `qwen-cctv-activity-v2-4s`.
- Four one-second crops of the same anonymous track are composed into one 2x2
  contact sheet.
- Phone requires visible active use in at least two frames; a phone on a table,
  a dark object or a hand near the face is insufficient.
- Working wins when laptop/document/tool use continues during casual speech.
- Talking requires sustained reciprocal interaction in at least two frames;
  proximity or one gesture is insufficient.
- The deterministic state machine requires two matching window decisions before
  starting or changing a stable label and holds through at most two uncertain
  windows.
- Five explicit reviewer corrections are frozen in
  `scripts/cctv-activity-pilot/corrections.v1.json`.
- Six CPU-side contract/state tests pass locally.

Next GPU step: restore the RunPod bundle, replay the corrected examples first,
then rerun the complete clip. Report correction pass/fail and all regressions
against the original Qwen-only result. Do not call the corrected examples a
held-out accuracy set.

Evaluation refinement: Qwen2.5-VL-7B performs the activity proposal. A generic
zero-shot Grounding DINO Tiny checkpoint now proposes phone regions; neither
project-specific phone checkpoint is loaded. Duplicate proposals are collapsed,
each handset can belong to only one nearby anonymous track, dark unattended desk
phones are rejected, and Qwen verifies a zoomed person-plus-marked-phone view.
In the targeted 20–42 second replay, the reviewed seated phone user alone became
`PHONE`; the standing track remained `NO TASK` and the laptop user remained
`WORKING`. The full clip and a held-out set still require a formal report; this
development observation is not completion of the evaluation.

Reviewer inspection later found that these local corrections reduced overall
label quality. The grounded/temporal experiment is therefore not the active
candidate. The preview has been rolled back to the untouched Qwen2.5-VL-3B
single-frame baseline for a clean comparison. Do not add further per-frame or
camera-zone exceptions until the baseline and candidate are scored against the
same reviewer-labelled sample set.

The next controlled comparison changes only the checkpoint from
Qwen2.5-VL-3B-Instruct to Qwen2.5-VL-7B-Instruct. Person tracking, one-second
sampling, person crops, prompt and single-frame decision logic remain identical.
This run is the active preview; it must be compared against the 3B baseline
before changing another variable.

Reviewer comparison judged the clean 7B checkpoint worse on the supplied clip,
so the active preview is restored to the unchanged Qwen2.5-VL-3B-Instruct
baseline. The 7B checkpoint is not an accuracy candidate for this pilot. The
next work must build a labelled comparison set and measure prompt, crop and
short-window variants independently before considering LoRA training.

A new isolated 3B candidate was run for reviewer inspection. It kept
Qwen2.5-VL-3B-Instruct as the only object/activity recogniser and changed the
evidence contract only: YOLO Pose locates wrists for crops, three consecutive
person-plus-hand panels are sent to Qwen, and Qwen first names the visible hand
object before making the activity decision. `PHONE` is displayed only when the
object pass explicitly reports a phone in at least two of the three frames;
otherwise a second Qwen pass chooses `WORKING`, `TALKING`, or `NO TASK`. There is
no `UNCERTAIN` display label, generic phone detector, project phone checkpoint,
camera-zone rule, or person-ID exception in this candidate. The untouched 3B
single-frame baseline remains preserved for rollback. This is a development
preview, not evidence that accuracy improved; it must be scored against the same
reviewer-labelled samples before adoption. The two-pass, three-image contract is
also expected to have materially higher latency than the single-frame baseline.

Reviewer inspection found this object-first candidate less accurate than the
single-frame 3B baseline. It is rejected and the live preview has been restored
to the untouched Qwen2.5-VL-3B-Instruct baseline. Do not combine this candidate's
object-first prompt, wrist panels, or two-of-three phone rule into the baseline.

An additional preview tested display-only temporal stabilization around that exact
baseline. The model, prompt, person crop, one-second sampling and raw Qwen
decisions were unchanged. An existing label remained visible during inference;
`UNCERTAIN` and isolated conflicting predictions do not replace it. A track is
initially labelled after two matching confident predictions and changed only
after three consecutive matching predictions. This adds up to roughly three
seconds of transition latency in exchange for reducing label flicker. The
original baseline remains preserved separately for rollback.

Reviewer inspection found that stabilization made the displayed result worse.
This variant is rejected and the live preview is again the exact untouched 3B
baseline. Do not add label hysteresis to the baseline without first defining and
scoring event-level transition behaviour on labelled sequences.

A two-frame context candidate was then tested in isolation. Each Qwen request
received two chronological composite images containing the highlighted full
scene and an enlarged target crop, and returned a label, evidence statement and
confidence. It failed immediately: scene-level laptops and papers were falsely
attributed to nearly every target, producing `WORKING` for all seven opening
tracks. Against the manually audited opening checkpoint it matched only 3 of 7
targets. The run was stopped at 17 video seconds, rejected, and the untouched 3B
baseline was restored. Do not include the full shared scene in each target's 3B
classification request.

The first reproducible development audit set is now recorded at
`scripts/cctv-activity-pilot/audit-set.v1.json`. It contains all detected tracks
at fixed 0, 20, 40 and 60 second checkpoints (28 target samples), with allowed
labels and visible-evidence notes. It includes 10 working, 4 phone, 12 no-task
and 2 talking-primary samples; two inherently ambiguous stills permit a second
label. This is a development set informed by prior reviewer corrections, not a
held-out accuracy set.

A prompt-only comparison then tested explicit positive and negative definitions
for phone, working, talking and no-task while holding the model, crop and frames
constant. The clearer prompt improved aggregate exact matches from 17/28 to
18/28, primarily by improving no-task and talking. It nevertheless regressed
the priority phone class from 4/4 to 3/4, working from 8/10 to 7/10, and changed
the known laptop user at track 16 from working to talking. The prompt is rejected
for the live pilot; the untouched baseline remains active. Summary metrics are
stored in `scripts/cctv-activity-pilot/prompt-comparison-v1.summary.json`.

A second prompt-only comparison preserved the original phone and working wording
and clarified only talking versus no-task. It tied the baseline at 17/28. Phone
remained 4/4 and working improved from 8/10 to 10/10, but no-task regressed from
4/12 to 2/12; talking remained 1/2. This candidate is also rejected because it
redistributed errors rather than reducing them. Its summary is stored in
`scripts/cctv-activity-pilot/prompt-comparison-selective.summary.json`.

The repository currently has substantial unrelated work in flight and the CCTV
viewer is externally hosted. Do not implement this task inside the CMS until the
deployment owner confirms the correct repository and host. Do not remount the
legacy `routes/cctv.js` router.

## 0. Security prerequisite

- Rotate the NVR credentials currently present as defaults in
  `services/cctv/config.js`.
- Replace credential defaults with required injected secrets and add a startup
  failure for missing production secrets.
- Replace the CCTV SSO fallback key with a required deployment secret.
- Search tracked files and deployment logs for the exposed values without
  printing them in task output.
- Record rotation completion without recording a secret.

Exit: old values no longer authenticate; no camera or SSO secret is sourced from
tracked code.

## 1. Pin the experimental contract

- Select the exact image-capable OpenJev repository, revision, checkpoint and
  licence disposition.
- Pin the serving container/dependencies and record its image digest.
- Freeze activity label descriptions, confidence policy and development/held-out
  split before measuring the held-out set.

Exit: a reviewer can reproduce which model, prompt contract and thresholds made
every decision.

## 2. Prove camera connectivity

- Create a read-only account for one channel.
- From the proposed worker host, validate RTSP connection, codec, resolution,
  frame rate, reconnect and time-to-first-frame.
- Confirm that logs redact all credentials.
- Capture no persistent media during this step.

Exit: a health record identifies the camera reference and technical stream facts,
but contains no RTSP secret.

## 3. Offline single-frame adapter

- Add an isolated OpenJev vision client; do not modify the central assistant
  `services/ai/openJev` path.
- Accept one already-decoded JPEG and the versioned five-label question.
- Validate the complete response and fail closed to `UNCERTAIN`.
- Unit-test timeouts, invalid JSON, unknown labels, probability failures,
  authentication and model-version drift.

Exit: consented fixture images can be evaluated without a live feed.

## 4. Live sampling worker

- Read RTSP over TCP and sample at a configurable bounded interval.
- Add reconnect backoff, deadline, circuit breaker, cancellation and health.
- Enforce one in-flight inference per camera/track; discard obsolete frames rather
  than building a queue.
- Keep the buffer in memory and expose no public stream endpoint.

Exit: disconnects and slow inference cannot cause unbounded memory, connections or
requests.

## 5. Anonymous person tracking

- Detect people and assign session-local track IDs.
- Crop with enough surrounding context for phone/laptop/conversation decisions.
- Define track loss/reacquisition behaviour.
- Prove that no face template, employee ID or cross-session biometric identifier
  is created.

Exit: two visible people receive separate observations without being identified.

## 6. Temporal events

- Implement the versioned start/end state machine from the product plan.
- Persist raw decisions and derived transitions separately.
- Add deterministic tests for jitter, short phone checks, missing frames, track
  loss, camera reconnect and low confidence.

Exit: replaying the same observation sequence produces the same event sequence.

## 7. Shadow-mode review

- Add a permission-scoped evaluation view in the external CCTV application.
- Show camera, time, anonymous track, selected label, confidence and model version.
- If evidence images are approved, enforce encryption, access audit and automatic
  expiry; otherwise show metadata only.
- Do not create alerts, productivity scores or HR records.

Exit: authorised reviewers can label a bounded sample and export only aggregated
evaluation metrics.

## 8. Held-out report and decision

Report per-class precision/recall, uncertainty, high-confidence errors, event-level
false alarms/misses, latency, availability and compute cost. Separate development
results from the untouched held-out camera/time windows. Recommend stop, revise or
advance; do not enable production monitoring automatically.
