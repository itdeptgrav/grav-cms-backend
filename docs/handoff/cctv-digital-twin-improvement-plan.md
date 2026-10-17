# GRAV CCTV Factory Digital Twin — Product, Architecture, and Improvement Plan

**Status:** Conference Room live pilot implemented; expansion and visual-quality work planned  
**Date:** 14 October 2026  
**Primary repositories:** `grav-cms` and `grav-cms-backend`

## 1. Handoff objective

Improve the existing GRAV CCTV digital twin without replacing its working
security, camera-registry, calibration, or live-tracking foundations.

The intended product is a spatially accurate, privacy-conscious factory view
where an authorised user can:

- see real rooms, cameras, furniture, equipment and anonymous occupants in 3D;
- switch between a factory overview, floor, room and individual camera;
- understand where each camera is mounted and what area it covers;
- calibrate a camera visually in either 2D or 3D;
- see people move at mapped floor positions with stable session-local tracks;
- inspect evidence-backed activities and objects without invented certainty;
- replay events and later ask aggregate operational questions;
- expand from the Conference Room pilot to approximately 20 live cameras on a
  single 12 GB VRAM GPU.

This document is an implementation brief. Inspect the current code and Git diff
before changing anything. Preserve unrelated work in both repositories.

## 2. Non-negotiable product principles

1. **Reality before decoration.** Never place a person, camera, object or room at
   a precise coordinate unless the supporting measurement/calibration exists.
2. **Detection is not understanding.** A detected phone is not proof of phone
   use. A detected chair is not proof that a person is sitting on it.
3. **Uncertainty must be visible.** Use `CALIBRATED`, `PROVISIONAL`, `DEGRADED`
   and `UNCERTAIN` states instead of hiding missing evidence.
4. **Identity is separate.** Live occupancy is anonymous by default. Any future
   employee identification requires separate authorisation, confidence and
   retention controls.
5. **No fake demo state in production.** Do not silently fall back to invented
   cameras, people, tracks, furniture or coordinates.
6. **The CMS owns access.** The viewer and worker must not expose CCTV secrets,
   bypass the existing CCTV grant, or put service credentials in browser code.
7. **The 12 GB / 20-camera budget is a design requirement.** Heavy inference is
   scheduled or candidate-triggered, not run continuously on every stream.

## 3. Current implemented state

### 3.1 Product surface

- Protected CMS route: `/cctv/twin`.
- The CCTV home links to both the original live-camera console and the factory
  digital twin.
- The twin loads the authoritative hosted CCTV registry. The current account
  resolves 32 accessible cameras.
- The Conference Room camera is `nvr1:11`.
- The user can select a camera, open its live console, and enter room/mapping
  setup from the same screen.

### 3.2 Conference Room pilot

- Room dimensions: **10 × 12 ft**; height currently recorded as about 9.02 ft.
- The room and camera configuration are saved and versioned.
- Camera placement and aim can be set on an interactive plan.
- Setup supports top-down and interactive isometric 3D modes.
- Four or more surveyed image/floor pairs are validated by the backend before
  precise projection is enabled.
- The saved pilot is `CALIBRATED`.
- The viewer renders room walls, the camera, its view direction, a conference
  table, chairs, articulated people and supported detected object geometry.

### 3.3 Live inference

- Primary people layer: **YOLOv8m + ByteTrack**.
- Current worker reads the real hosted Conference Room MJPEG stream.
- It publishes anonymous, camera-local tracks to the CMS.
- Track observations expire after four seconds and are not stored as video.
- A bounded hold smooths brief occlusion/detector misses.
- Duplicate person boxes are suppressed.
- The difficult supplied Conference Room image was independently verified to
  contain exactly three detectable people. The live pipeline has published
  three when all three are present; the count changes with the real feed.
- Seated/occluded floor locations may be emitted only as a visibly
  `DEGRADED` occupancy proxy until stronger pose and floor evidence exist.

### 3.4 YOLO-World scene discovery

- **YOLO-World small v2** is integrated as a low-frequency secondary layer.
- It uses a fixed office vocabulary such as chair, conference table, laptop,
  monitor, bottle, cup, keyboard, mobile phone, document, backpack and bin.
- It does not create people or modify the authoritative person tracker.
- It runs periodically rather than on every frame.
- On the current low-resolution Conference Room feed it has not produced
  sufficiently confident object detections. This abstention is correct; do not
  lower thresholds merely to make the 3D room look populated.
- Surveyed/static furniture and live detector objects must remain visually and
  semantically distinct.

### 3.5 Verification already passing

- Backend live/spatial twin tests: 14/14 passing.
- Python worker compiles.
- Frontend targeted lint passed after the current 3D/calibration changes.

## 4. Current architecture

```text
Hosted CCTV registry and MJPEG stream
               |
               v
Isolated vision worker
  - YOLOv8m person detector
  - ByteTrack continuity
  - low-frequency YOLO-World scene proposals
  - no employee identity
               |
               v
Authenticated internal observation endpoint
  - validates camera/session/frame/tracks/objects
  - applies saved calibration
  - precise, degraded or rejected spatial result
  - keeps only short-lived in-memory snapshots
               |
               v
Access-controlled CMS observation endpoint
               |
               v
React + Three.js factory twin
  - room and camera geometry
  - calibrated anonymous people
  - surveyed furniture
  - confidence/state indicators
```

Important boundaries:

- CCTV credentials remain backend-side.
- The frontend receives only authorised camera metadata and observations.
- The 3D viewer does not call detector internals directly.
- Model-specific output is normalised before it reaches the UI.
- Configuration is versioned; live observations are ephemeral.

## 5. Model roles — keep these responsibilities separate

| Layer | Recommended role | Must not claim |
| --- | --- | --- |
| YOLOv8m | People boxes and primary occupancy candidates | Activity, identity, posture certainty |
| ByteTrack | Short-lived track continuity | Cross-camera or employee identity |
| Lightweight pose | Sitting/standing, joints, body orientation, hand/ear geometry | Phone ownership or intent by itself |
| YOLO-World | Low-frequency open-vocabulary object proposals | Precise room inventory from weak frames |
| Dedicated object detector | Repeated factory-specific objects after labelled training | General scene understanding |
| Temporal action model | Movement evidence over a bounded person clip | Final activity decision by itself |
| Small semantic verifier | Resolve candidate/conflicting windows only | Continuous 20-camera monitoring |
| Calibrated fusion | `ACTIVE`, `NOT_ACTIVE`, `UNCERTAIN` from all evidence | Certainty outside measured validation |

## 6. Recommended next integration

### 6.1 Add lightweight pose as the next inference layer

This is the most valuable immediate addition.

Run pose only on active person regions at a reduced cadence. Publish:

- keypoints and per-keypoint confidence;
- inferred posture: `STANDING`, `SEATED`, `CROUCHED`, `UNKNOWN`;
- body yaw/orientation band;
- visibility/occlusion score;
- estimated ground anchor and its quality;
- optional wrist/ear relationships for later phone-use evidence.

Do not hardcode Conference Room occupants as seated. Posture must come from
pose/geometry or remain `UNKNOWN`. Smooth posture temporally so it does not
change every frame.

Candidate implementation:

- use a small/medium Ultralytics pose model;
- batch person crops across cameras;
- infer at approximately 1–2 Hz per active track;
- retain the primary person detector/tracker at the camera sampling rate;
- use hysteresis or a short state machine for posture transitions;
- measure actual latency and peak memory on the 12 GB deployment GPU.

### 6.2 Do not add these continuously yet

- A vision-language model on every frame.
- Monocular depth on every frame.
- Generative reconstruction of furniture or people.
- Face recognition inside the occupancy pipeline.
- Jev as a visual detector.

A small VLM may later verify ambiguous event windows. Depth may help during
one-time room setup. Neither should be the continuous primary tracker.

## 7. 3D experience requirements

### 7.1 Visual hierarchy

The twin should support four navigable levels:

1. **Factory:** measured buildings, floors and zones.
2. **Floor:** rooms, corridors, entrances and camera coverage.
3. **Room:** furniture/equipment, live occupants and detected objects.
4. **Camera:** source video, calibration evidence and mapped 3D result.

Selecting a camera in any level should focus its room and expose Live,
Playback, Calibration and Evidence actions without leaving the twin unless the
user explicitly opens the original camera console.

### 7.2 Realistic people

Replace primitive articulated avatars with an efficient reusable human asset:

- one neutral, low-poly but human-looking GLB skeleton/mesh;
- GPU instancing or shared geometry/materials;
- small appearance variations without implying identity;
- standing, seated, walking and unknown/low-confidence poses;
- orientation derived from pose/tracking evidence;
- smooth interpolation without teleporting;
- a visible degraded/uncertain treatment when position or posture is weak.

Do not attempt photorealistic reconstruction of each employee. The avatar may
look human but must remain anonymous unless a separately authorised identity
feature is later enabled.

### 7.3 Furniture and equipment

Use two sources and show their provenance:

- **Surveyed layout objects:** persistent room furniture placed during room
  setup, such as the table, chairs, doors, workstations and machines.
- **Detected transient objects:** short-lived evidence such as a moved chair,
  laptop, bottle, box or trolley.

Add a room-layout editor that lets an administrator:

- drag/drop furniture from a small catalogue;
- resize, rotate, duplicate and delete items;
- snap to walls/floor and enter exact dimensions when known;
- assign stable IDs and semantic types;
- mark an item `SURVEYED`, `APPROXIMATE` or `DETECTED`;
- save versioned changes with an undoable draft before publishing.

Detected objects must not silently rewrite the surveyed layout. Instead, show a
review suggestion such as “possible moved chair” when consistent evidence
persists.

### 7.4 3D calibration

Keep the existing 2D method and make 3D a better interface over the same
validated geometry.

Required workflow:

1. Enter/import measured room dimensions.
2. Place camera on a wall/corner in the 3D room.
3. Drag its aim target and adjust mount height.
4. Show a live frustum/coverage preview.
5. Pair a fixed floor landmark in the CCTV still with the same point on the 3D
   room floor.
6. Collect at least four well-spread, non-collinear surveyed pairs.
7. Validate server-side and display reprojection error.
8. Save as draft when weak; activate only when the calibration gate passes.

The user does not need to see raw X/Y values by default. An advanced section
may expose them for audit and fine adjustment.

### 7.5 Recommended mapping UX — guided overlay

The primary workflow should feel like aligning a map, not configuring a vision
model. Use three short screens:

1. **Place camera:** show the measured room in 3D. The user drags a camera icon
   onto the real wall/corner, sets its height with a simple vertical handle, and
   drags an aim target toward the part of the room it faces.
2. **Align view:** show the 3D room and CCTV still side by side. Project the room
   floor grid and wall/floor boundary as a transparent overlay on the CCTV
   image. The user drags four well-spread handles until the overlay sits on
   known floor landmarks. Pair selection remains available as a fallback when
   a room boundary is hidden.
3. **Verify:** ask someone to stand on two or three highlighted floor targets,
   or place a printed marker there. Show the mapped anonymous avatar in the 3D
   room at the same time. The user confirms the visual match; the backend also
   checks reprojection error before activation.

Add an optional **Auto align** action that proposes camera direction and visible
floor boundaries using scene geometry. Its result is always a draft and cannot
activate calibration without visual verification. Avoid making users type X/Y,
rotation, tilt or field-of-view values during the ordinary flow.

The UI should continuously show one plain-language quality state:

- `Needs more spread` — landmarks are too close together;
- `Move this point` — a pair creates high projection error;
- `Good alignment` — all checks pass, with the average error shown in cm;
- `Verify in room` — geometry passes but has not been physically confirmed;
- `Calibrated` — geometry and physical visual verification both pass.

## 8. Calibration validity requirements

A calibration becomes active only when:

- the camera belongs to the authorised hosted registry;
- measured room units and dimensions are present;
- at least four exact floor correspondences exist;
- points are sufficiently spread and non-collinear;
- the homography can be solved and inverted safely;
- reprojection error is below a configured threshold;
- the mapped area is a valid floor polygon;
- an administrator explicitly confirms the points are surveyed landmarks;
- configuration version and audit actor are recorded.

Never treat people, chair seats, table surfaces, guessed corners or image edges
as floor landmarks. When all room corners are not visible, use tape markers,
tile intersections, door thresholds or other fixed floor points whose room
coordinates are known.

## 9. Live observation contract

Preserve a model-independent payload similar to:

```json
{
  "cameraRef": "nvr1:11",
  "sessionRef": "worker-session-id",
  "observedAt": "ISO-8601",
  "frameSize": { "width": 1280, "height": 720 },
  "tracks": [
    {
      "sourceTrackId": "17",
      "label": "PERSON",
      "confidence": 0.91,
      "imageAnchor": { "x": 0.52, "y": 0.83 },
      "visual": {
        "posture": "SEATED",
        "postureConfidence": 0.86,
        "orientationDeg": 140
      }
    }
  ],
  "objects": [
    {
      "sourceObjectId": "chair-4",
      "type": "CHAIR",
      "confidence": 0.78,
      "imageAnchor": { "x": 0.66, "y": 0.79 },
      "source": "YOLO_WORLD"
    }
  ]
}
```

Backend validation decides whether each image anchor becomes an exact world
point, a degraded occupancy estimate, or a rejected observation.

## 10. Twenty-camera / 12 GB runtime plan

Do not instantiate every model separately for every camera.

Use a central scheduler:

```text
20 camera decoders
  -> adaptive frame sampler
  -> batched people detector
  -> per-camera tracker state
  -> pose queue for active people at lower cadence
  -> object discovery queue at much lower cadence
  -> candidate event windows only
  -> optional action/VLM verification queue
  -> normalized CMS observations/events
```

Operational controls:

- prioritise visible/selected cameras without starving others;
- dynamically reduce sampling for empty/stable rooms;
- cap concurrent pose/object jobs;
- discard stale queued work rather than publishing late truth;
- use one loaded model instance per model/GPU process;
- expose queue age, FPS, dropped frames, GPU memory and per-camera health;
- degrade to people-only tracking under load;
- run semantic verification only on bounded candidates;
- keep decoding and networking off the model hot path where possible.

Initial target cadences to benchmark, not hardcode permanently:

- people detection: 2–5 sampled FPS per camera depending on motion;
- tracker updates: every processed detection frame;
- pose: 1–2 Hz per active person;
- YOLO-World/static object discovery: every 8–30 seconds per room;
- activity/action verification: only for candidate windows.

## 11. Phone-use and activity extension

The digital twin may later display evidence-backed activities, but the existing
multi-level evidence cascade remains authoritative:

```text
quality gate
 -> anonymous person detector/tracker
 -> phone/object proposals
 -> pose and ownership geometry
 -> temporal action evidence
 -> bounded semantic verifier for candidates/conflicts
 -> calibrated ACTIVE | NOT_ACTIVE | UNCERTAIN fusion
 -> temporal event state machine
 -> optional separately authorised identity
```

Never let YOLO-World, a phone box, pose, or a VLM independently label someone
as actively using a phone. Keep cups, pens, remotes, nearby desk phones and
occluded hands in the hard-negative test set.

## 12. Data, replay and analytics roadmap

### Phase A — live anonymous twin

- Complete pose integration and stable avatars.
- Complete room/furniture editor.
- Add per-camera health and calibration-quality UI.
- Expand calibration to a small representative camera set.

### Phase B — event storage and replay

- Persist typed observation/event summaries, not unrestricted raw surveillance.
- Add configurable retention.
- Replay a room/floor timeline with model/version/confidence provenance.
- Link an event back to authorised source footage where retention permits.

### Phase C — factory model

- Import a measured 2D plan or GLB with stable floor/zone IDs.
- Place calibrated rooms/cameras into the factory coordinate system.
- Add cross-camera handoff only in overlapping, measured regions.
- Keep anonymous track continuity separate from employee identity.

### Phase D — operational questions

Support questions only over validated stored events, for example:

- occupancy by room and time range;
- unusually long idle/blocked-area events;
- safety-zone violations;
- phone-use review candidates above a confidence threshold;
- equipment or material movement summaries.

Questions about named employees require the separately authorised identity
layer, explicit company policy, retention limits and human review. The product
must not present uncertain model output as an employee fact.

## 13. Security, privacy and governance

- Preserve the existing CMS authentication and CCTV permission boundary.
- Never send `CCTV_KEY`, `CCTV_SSO_SECRET` or service credentials to the browser.
- Keep internal observation writes authenticated and company-scoped.
- Record configuration actor, timestamp and version.
- Make raw-video retention opt-in and time-bounded.
- Store identity and activity confidence separately.
- Provide audit logs for calibration, model/version changes and human review.
- Do not use the system for automatic disciplinary decisions.
- Add a visible privacy/coverage indicator in the production twin.

## 14. Implementation sequence for Claude Code

Work sequentially and keep each change reviewable.

### Task 1 — current-state audit

- Read the files listed in section 16.
- Run the focused backend twin tests and frontend lint.
- Document observed payloads and rendering state.
- Do not rewrite the working calibration or access flow.

### Task 2 — typed pose evidence

- Extend the observation schema with optional pose/posture/orientation fields.
- Validate fields and confidence ranges in the backend.
- Add tests for valid, missing and malformed pose evidence.
- Keep old workers backward compatible.

### Task 3 — scheduled pose worker

- Add one lightweight pose model instance.
- Run only on tracked-person crops at a bounded cadence.
- Add temporal smoothing and `UNKNOWN` fallback.
- Measure CPU/GPU latency and peak memory.
- Remove any room-specific hardcoded posture.

### Task 4 — avatar upgrade

- Introduce one efficient anonymous humanoid asset with shared resources.
- Map posture/orientation evidence to standing/seated/unknown states.
- Preserve stable interpolation and degraded styling.
- Add a safe primitive fallback if the asset fails to load.

### Task 5 — room-layout editor

- Add drag/drop/rotate/resize for surveyed furniture in 2D and 3D.
- Persist versioned room objects separately from transient detector objects.
- Add draft/publish behavior and administrator-only writes.
- Add visible provenance for surveyed, approximate and detected objects.

### Task 6 — calibration UX and quality

- Improve the 3D camera/frustum and 3D landmark-pairing interface.
- Calculate and show reprojection error and coverage polygon.
- Explain failures in plain language at the point of action.
- Retain server-side validation as the authority.

### Task 7 — multi-camera scheduler prototype

- Separate stream decode, sampling, batched inference and publishing.
- Add backpressure/staleness policies and metrics.
- Benchmark a representative camera set before claiming 20-camera capacity.

### Task 8 — evaluation

- Build positive and hard-negative fixtures from authorised footage.
- Evaluate per camera, distance, occlusion and person-pixel size.
- Report misses, false positives, ID switches, latency and uncertainty rate.
- Do not tune on the final holdout.

## 15. Acceptance criteria for the next milestone

- The Conference Room displays the current live person count without duplicate
  workers or stale sessions overwriting it.
- Avatars look recognisably human while remaining anonymous.
- Sitting/standing comes from typed pose evidence and is temporally stable.
- Static furniture is editable, persistent and clearly marked as surveyed or
  approximate.
- Transient detected objects cannot modify the surveyed room automatically.
- Calibration can be completed visually in 2D or 3D and displays quantitative
  quality/error.
- Invalid calibration never produces precise person coordinates.
- The system visibly falls back to people-only mode when auxiliary inference is
  unavailable or overloaded.
- No secret reaches browser code.
- Focused backend tests, frontend lint and a live one-camera visual check pass.
- A benchmark reports actual latency and memory before any 20-camera claim.

## 16. Key files to inspect first

Backend:

- `routes/cctvSso.js`
- `services/cctv/cctvLink.js`
- `services/cctv/factoryTwinConfig.service.js`
- `services/cctv/factoryTwinLayout.js`
- `services/cctv/factoryTwinSpatial.service.js`
- `services/cctv/factoryTwinLive.service.js`
- `scripts/cctv-twin-person-worker.py`
- `test/cctv/factory-twin-live.test.js`
- `test/cctv/factory-twin-spatial.test.js`

Frontend:

- `app/cctv/page.js`
- `app/cctv/twin/page.js`
- `components/cctv/FactoryTwinWorkspace.js`

Durable product/architecture context:

- `docs/tasks/cctv-factory-digital-twin.md`
- `docs/decisions/cctv-phone-use-evidence-cascade.md`
- `docs/audits/cctv-phone-use-real-cctv-stress-2026-10-14.md`

## 17. Explicit non-goals for the next milestone

- Photorealistic employee replicas.
- Automatic employee identification.
- Automatic disciplinary or payroll decisions.
- A generative guess of the complete factory from CCTV frames.
- Continuous VLM processing on all cameras.
- Unreviewed replacement of measured geometry with object detections.
- A claim of reliable phone-use analytics before the evaluation gates pass.

## 18. Definition of done for any Claude change

Before handoff, Claude should provide:

1. a concise explanation of what changed and why;
2. exact files changed;
3. tests/lint/build commands and results;
4. a live screenshot or reproducible visual check for UI work;
5. measured latency/VRAM for inference changes;
6. known failure cases and fallback behavior;
7. confirmation that unrelated dirty-worktree changes were preserved;
8. any proposed architecture change recorded under `docs/decisions/` before it
   becomes an implicit application-code decision.

