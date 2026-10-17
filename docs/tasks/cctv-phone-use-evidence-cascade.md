# CCTV phone-use evidence cascade — sequential implementation task

Status: PU-00 through PU-02 implemented in the isolated vision worker. The
real-CCTV failure review added PU-00R before PU-03 so active-use labels cannot
be inferred from detector output. Shadow mode only.  
Decision: `docs/decisions/cctv-phone-use-evidence-cascade.md`.

Measured memory evidence:
`docs/audits/cctv-phone-use-12gb-profile-2026-10-13.md`. The complete selected
six-model resident stack passed an enforced 11.5 GiB allocator ceiling at
8.172 GiB peak allocated and 8.426 GiB peak reserved. This closes the initial
memory-feasibility question, not the PU-08 representative-replay gate.

## PU-00 — freeze evidence and fixtures

- Preserve the 30-clip and 12-clip reports as immutable development evidence.
- Record source, consent/licence, ground truth and hashes for each clip.
- Add one machine-readable evaluation manifest with source-group IDs.
- Do not tune against a file after moving it into an untouched holdout.

Acceptance: one command validates manifest completeness and clip hashes.

## PU-00R — camera-matched human-review boundary

- Use mutually exclusive window labels: `NO_PHONE`, `PHONE_VISIBLE`,
  `PHONE_HELD`, `NOT_ACTIVE_UNSPECIFIED`, `ACTIVE_VIEW_OR_TYPE`, `ACTIVE_CALL`,
  `ACTIVE_USE_UNSPECIFIED` and `UNCERTAIN`.
- Keep model suggestions separate from reviewer labels; a model output may
  prioritise a queue item but may never populate ground truth.
- Review fixed four-to-six-second windows rather than copying one long detector
  state over a complete track.
- Require reviewer identity, review time and confidence for every labelled row.
- Fail validation when a source group crosses development, calibration and
  holdout splits, or when exact clip/track/window duplicates disagree.

Acceptance: the versioned JSONL validator and worker-log queue converter pass
their focused tests; real-CCTV logs can be converted to pending review windows
without assigning labels automatically.

Completed evidence (14 Oct 2026): the isolated
`scripts/cctv_phone_use_pilot` package implements the review schema, strict
dataset validator and fixed-window queue conversion for both JSON reports and
mixed worker logs. The Cam 20 stress log converts to
nine pending candidate windows; the negative Cam 09 log converts to 28 pending
four-second windows. These counts are review workload, not accuracy evidence.

The review merge and independent-adjudication boundary are implemented and
covered by 19 focused tests. The merge rejects
duplicate or unknown decisions, incomplete review sets and input overwrite.
The first Codex visual audit completed all 37 development windows. It is
explicitly provisional: an independent human must adjudicate the review before
these labels can be used for calibration, and neither source group may be moved
to holdout after being inspected.

Two round-two JSONL queues are frozen under `docs/audits/evidence/`. They hide
the first review, its evidence and the model suggestion. The comparison command
requires a different reviewer and reports exact-state agreement separately from
agreement on the active-use boundary. This is the current PU-00R gate.

## PU-01 — typed observation schema

- Implement the versioned per-window evidence envelope.
- Represent missing model output explicitly; never coerce it to zero/negative.
- Add JSON-schema validation and deterministic serialisation.

Acceptance: valid fixture round-trips; invalid probabilities, labels, times and
versions fail closed.

## PU-02 — quality and tracking layer

- Consolidate YOLO person detection and ByteTrack/BoT-SORT continuity.
- Emit blur/exposure, person pixels, occlusion, track age and ID-switch clues.
- Build chronological per-track ring buffers with bounded memory/backpressure.

Acceptance: replay produces stable typed observations and no unbounded queue.

Completed evidence (13 Oct 2026): 15 schema/tracking tests pass. Two independent
15-second replays of the difficult `cam09` CCTV clip each emitted 485
chronological observations over 11 track IDs and produced the identical JSONL
SHA-256 `b79ac8450168c9ba021e0ba29aa2c62fd39fd3417a4469341f067f5035dc90a6`.
The maximum resident track count was 11 against a configured 128-track cap;
each track history was capped at 180 observations. PU-02 emits blur, exposure,
person-pixel height, occlusion, ID-switch risk and track-quality evidence only;
it sets no phone-use/activity verdict.

## PU-03 — proposal and geometry features

- Run the available phone checkpoints as proposal generators only.
- Deduplicate proposals while retaining per-model scores.
- Add YOLO11x Pose wrist/ear features, ownership assignment, contact,
  persistence and motion-coupling features.
- Mark low-resolution evidence `UNCERTAIN` rather than forcing a decision.

Acceptance: feature fixtures cover calls, handheld viewing, unattended phones,
cups, pens, remotes, laptop use, overlap and occlusion.

## PU-04 — temporal action features

- Pin the selected action checkpoint and class mapping.
- Emit logits over four-to-six-second person windows.
- Preserve drinking/writing/typing/remote confuser logits alongside phone-use
  logits.

Acceptance: deterministic replay emits aligned timestamped features without
directly setting the final activity.

## PU-05 — Qwen candidate verifier

- Run a frozen verifier bake-off under a hard 12 GB VRAM limit. Compare the
  existing Qwen2.5-VL 3B baseline with eligible quantized alternatives;
  Qwen3-VL 8B BF16 is an offline teacher only.
- Serve the selected verifier once per worker, not once per clip.
- Build chronological packets with overview, person, hand/ear and marked-phone
  views.
- Enforce the typed four-field response and a strict deadline.
- Invoke Qwen only for candidate or conflicting windows.

Acceptance: all responses validate or become `UNCERTAIN`; hard-negative fixtures
include phones lying nearby and non-phone held objects. Worst-case measured peak
allocated plus reserved CUDA memory stays below 11.5 GB and the report records
quality, latency, throughput and uncertainty rate.

## PU-06 — learned calibrated fusion

- Export one feature table from labelled development windows.
- Train an interpretable baseline and a small tree model using grouped splits.
- Calibrate probabilities on a separate calibration fold.
- Choose `ACTIVE`/`NOT_ACTIVE` thresholds before the untouched holdout and
  preserve `UNCERTAIN` between them.
- Record feature importance and reason codes without presenting them as causal.

Acceptance: training cannot access holdout rows; artefact contains schema hash,
model hash, calibration data hash and thresholds.

## PU-07 — temporal event engine

- Convert window verdicts to start/update/end events.
- Measure decision delay, gap merging, duplicates and duration error.
- Keep raw windows linked to every event.

Acceptance: deterministic event fixtures cover short gaps, track loss, ID
switches and conflicting evidence.

## PU-08 — live shadow preview

- Replace single-model labels with one fused label plus confidence/uncertainty.
- Expose expandable evidence from every layer and its version.
- Display `warming_up`, `uncertain`, `candidate`, `active` and `ended` states.
- Do not display employee names in this slice.

Acceptance: recorded CCTV can be replayed with live overlays and a downloadable
evidence ledger; UI never implies a low-quality window is certain.

The preview must also expose current/peak VRAM, queue depth and dropped stale
candidate count. A representative multi-person replay must complete on a 12 GB
GPU without OOM or silent model substitution.

## PU-09 — optional identity join

- Integrate the separately authorised recognition service after an activity
  event exists.
- Store recognition confidence and provenance independently.
- Support anonymous/unresolved events and correction by an authorised reviewer.

Acceptance: disabling identity changes no activity result; identity failure does
not drop the event.

## PU-10 — frozen camera-matched holdout

- Collect the minimum event counts and representative conditions in the
  decision document.
- Freeze all artefacts before evaluation.
- Report precision, recall, uncertainty/coverage, camera/distance/pixel-band
  slices, ID switches, duration error, latency and model availability.

Acceptance: production remains blocked unless every adoption gate is met.

