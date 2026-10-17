# Claude implementation brief — CCTV factory digital twin

Status: implementation handoff  
Date: 14 October 2026  
Repositories: `/Users/risheeray/grav-cms-backend` and `/Users/risheeray/grav-cms`

## Your assignment

Build the first usable version of a live 3D factory digital twin for the GRAV
CCTV project. The product owner will supply or create a 3D factory layout and
will place each camera at its real location. The system must show calibrated
camera coverage and replay/live anonymous person tracks at their approximate
factory-floor positions. Activity labels, including phone-use candidates, are
overlays on those tracks; they are not inferred by the 3D renderer.

Implement this as a small, reviewable vertical slice. Begin with recorded CCTV
replay and two or three cameras. Do not claim twenty-camera production readiness
from a single-camera or synthetic demonstration.

Before editing application code, read and follow:

- `AGENTS.md`
- `docs/decisions/cctv-hybrid-event-architecture.md`
- `docs/decisions/cctv-phone-use-evidence-cascade.md`
- `docs/audits/cctv-phone-use-12gb-profile-2026-10-13.md`
- `docs/audits/cctv-phone-use-real-cctv-stress-2026-10-14.md`
- `docs/tasks/cctv-phone-use-evidence-cascade.md`

Inspect both repositories and the separately hosted CCTV boundary before
choosing file locations. Reuse existing authentication, company scoping,
permissions, event delivery and design components. Do not remount the legacy
`routes/cctv.js` RTSP/HLS path in the monolithic CMS.

## Product outcome

An authorised user can open a factory digital-twin page and:

1. load a versioned `.glb`/`.gltf` factory model;
2. see named factory zones and the position, orientation and field-of-view cone
   of every configured camera;
3. select a camera and see its metadata and calibration status;
4. replay a recorded session and see anonymous tracked people move across the
   corresponding factory floor;
5. inspect a selected track's current observable state, confidence, evidence
   quality and source camera;
6. see uncertain results presented as uncertain rather than as facts;
7. switch between the 3D view, a simple top-down view and the source video;
8. scrub the replay timeline without the 3D scene and source video drifting out
   of sync; and
9. download or inspect the typed event/evidence ledger used to render the
   session.

The first slice is anonymous. Employee recognition is a later, independently
authorised join and must not be required for location or activity rendering.

## Architectural boundary

```text
Read-only NVR substream or recorded replay
        |
        v
Isolated ingest + bounded ring buffer
        |
        v
Person detector/tracker ---------> phone-use evidence cascade
        |                                    |
        v                                    v
Per-camera floor projection       typed activity window/event
        |                                    |
        +---------------+--------------------+
                        v
              spatial/event normaliser
                        |
                        v
          company-scoped twin event stream
                        |
              +---------+----------+
              |                    |
              v                    v
       3D/top-down viewer      evidence ledger

Optional later input:
RuView/CSI zone occupancy -> sensor adapter -> coarse zone observations only
```

The vision worker owns frames, inference and short-lived evidence. GRAV stores
typed events, calibration/configuration metadata and protected evidence
references. The browser must never receive RTSP credentials, model secrets or
an unrestricted evidence-store URL.

## Important semantic rules

- A detector bounding box is not a floor location. Project the bottom-centre
  foot point only after camera calibration.
- A phone proposal is not active phone use.
- A session-local track ID is not an employee identity.
- Cross-camera matching is probabilistic. Preserve separate source track IDs
  and expose uncertainty instead of silently merging people.
- Low resolution, occlusion, poor calibration and stale observations reduce
  confidence and may produce `UNCERTAIN`.
- Do not infer productivity, intent, misconduct, conversation content, emotion
  or employee performance.
- No automated disciplinary action may consume these events.
- Never store continuous video in the CMS database.

## Coordinate and calibration contract

Use a right-handed factory coordinate system in metres:

- `x`: factory east/right;
- `y`: height above the floor;
- `z`: factory north/forward;
- floor observations normally have `y = 0` or a configured floor elevation;
- all model, camera and zone transforms refer to one versioned site origin.

Each camera configuration must include:

```json
{
  "cameraRef": "cam-20",
  "siteRef": "factory-reference",
  "modelVersion": "factory-layout-v1",
  "positionM": { "x": 0, "y": 3.4, "z": 0 },
  "rotationDeg": { "pitch": 0, "yaw": 0, "roll": 0 },
  "horizontalFovDeg": 78,
  "imageSize": { "width": 1920, "height": 1080 },
  "floorPlane": { "elevationM": 0 },
  "imageControlPoints": [],
  "worldControlPointsM": [],
  "homography": null,
  "reprojectionErrorPx": null,
  "calibrationStatus": "DRAFT | VALID | REJECTED",
  "configVersion": "cam-20-calibration-v1"
}
```

Provide a calibration workflow in which an authorised configurator marks at
least four non-collinear floor points in a reference camera frame and enters or
selects their corresponding factory coordinates. Compute and persist the
homography, show residual/reprojection error and prevent a calibration from
becoming `VALID` when required points are missing or the transform is
degenerate. More than four well-spread points should be supported and used for
validation.

For each person observation:

1. take the bottom-centre of the person box as the tentative foot point;
2. map it through the pinned camera calibration;
3. reject or mark uncertain points outside the calibrated polygon;
4. include calibration version and projection quality in the observation; and
5. smooth display motion without altering the preserved raw coordinates.

Do not reconstruct full 3D human bodies in the first slice. Render a marker,
capsule or lightweight avatar anchored to the floor. A full skeleton is not
required and would imply more accuracy than the input supports.

## Required typed event

Use or extend the existing CCTV envelope rather than introducing an unrelated
untyped socket payload. The spatial observation should be equivalent to:

```json
{
  "schemaVersion": "factory-twin-observation-v1",
  "eventId": "stable-idempotency-key",
  "companyRef": "company-reference",
  "siteRef": "factory-reference",
  "cameraRef": "cam-20",
  "sessionRef": "recorded-or-live-session",
  "sourceTrackId": "5",
  "globalTrackRef": null,
  "observedAt": "ISO-8601 timestamp",
  "receivedAt": "ISO-8601 timestamp",
  "worldPositionM": { "x": 12.42, "y": 0, "z": 8.15 },
  "worldVelocityMps": { "x": 0.1, "y": 0, "z": -0.2 },
  "projection": {
    "quality": "GOOD | DEGRADED | UNRESOLVABLE",
    "confidence": 0.0,
    "insideCalibratedArea": true,
    "calibrationVersion": "cam-20-calibration-v1"
  },
  "tracking": {
    "confidence": 0.0,
    "ageFrames": 0,
    "idSwitchRisk": 0.0
  },
  "activity": {
    "label": "NO_PHONE | PHONE_VISIBLE | PHONE_HELD | NOT_ACTIVE_UNSPECIFIED | ACTIVE_VIEW_OR_TYPE | ACTIVE_CALL | ACTIVE_USE_UNSPECIFIED | UNCERTAIN",
    "confidence": 0.0,
    "eventRef": null,
    "evidenceRef": null,
    "pipelineVersion": "phone-use-cascade-version"
  },
  "versions": {
    "detector": "pinned-revision",
    "tracker": "pinned-revision",
    "spatialNormaliser": "factory-spatial-v1"
  }
}
```

Validate every incoming observation. Reject invalid coordinates, invalid
probabilities, unknown enum values, missing company/site scope, timestamps too
far outside the session and events whose camera/calibration/site versions do
not agree. Make ingestion idempotent.

## 3D and user-interface requirements

Use the existing frontend framework. For the scene layer, use Three.js through
React Three Fiber if compatible with the current dependency stack; otherwise
use Three.js directly. Do not introduce a second frontend framework.

Required scene objects:

- versioned factory `.glb`/`.gltf` model;
- floor grid and metre scale;
- configurable zones with names and colours;
- camera model, orientation arrow and frustum/coverage cone;
- anonymous person markers with stable colour per session-local/global track;
- short bounded movement trail;
- activity status ring/badge using the existing phone-use ontology;
- stale, uncertain and offline visual states;
- selected-track evidence/details panel; and
- timeline/play/pause/speed controls for replay.

Do not render a new activity label every frame. Display the current state from
the temporal event engine, with visible `warming_up`, `candidate`, `uncertain`,
`active` and `ended` states where available. Keep source timestamps visible.

Performance safeguards:

- use instancing or similarly cheap geometry for people and trails;
- do not load CCTV frames as 3D textures unless the user opens the source-video
  panel;
- cap trail history and browser-side event buffers;
- discard obsolete position updates when the UI falls behind;
- interpolate only for display and never fabricate source observations;
- pause expensive rendering when the page is hidden; and
- expose stream lag, dropped updates and last-event time in diagnostics.

## Replay-first vertical slice

Build the first end-to-end demonstration from recorded evidence, not simulated
random movement. It must support:

1. one versioned factory model or a clearly marked temporary test floor if the
   real `.glb` is not yet supplied;
2. two or three real camera configurations;
3. at least one recorded CCTV session with actual tracker observations;
4. deterministic replay from a timestamped JSONL/NDJSON fixture;
5. synchronised 3D positions, source video and activity events;
6. pause, seek and replay at `0.5x`, `1x`, `2x` and `4x`; and
7. a visible notice identifying replay mode so it cannot be mistaken for live.

If the real factory model or survey coordinates are unavailable, implement the
import/configuration boundary and use a temporary metre-scaled test floor.
Record that limitation; do not invent factory measurements.

## Cross-camera fusion

Cross-camera global tracking is not required to complete the first vertical
slice, but design the contract so it can be added without changing event
history.

For overlapping cameras, a future fusion service may use:

- compatible timestamps;
- projected spatial proximity and plausible velocity;
- entry/exit topology between zones;
- anonymous appearance embeddings where authorised; and
- an explicit confidence threshold with an `UNRESOLVED` outcome.

Never use `sourceTrackId` as a globally unique identity. A proposed global
match must keep its source observations and may later be split or corrected.

## RuView boundary

RuView (`https://github.com/ruvnet/RuView`) is optional and is not part of the
first acceptance gate. If an adapter is scaffolded, it may emit only coarse,
anonymous sensor observations such as:

```json
{
  "sensorType": "WIFI_CSI",
  "zoneRef": "cutting-zone-a",
  "observedAt": "ISO-8601 timestamp",
  "occupancy": 4,
  "motion": "NONE | LOW | ACTIVE | UNCERTAIN",
  "confidence": 0.0,
  "sensorVersion": "pinned-version"
}
```

RuView may help identify occupied zones, movement with an obstructed camera or
after-hours presence. It may not declare phone use, identify an employee or be
used as ground truth for camera detections. Keep it behind a provider-neutral
`zone sensor` interface so it can be removed without affecting CCTV tracking.
Do not clone, install or deploy RuView in this implementation unless the product
owner separately asks for the hardware pilot.

## Twenty-camera / 12 GB VRAM constraint

The current six-model phone-use stack measured approximately 8.43 GiB reserved
under an 11.5 GiB allocator ceiling, but the existing fused implementation was
not real-time. Do not run a full heavy cascade independently for every camera.

Use this scheduling shape:

- decode low-resolution NVR substreams with hardware acceleration when
  available;
- continuously run shared batched person detection/tracking at a configured low
  cadence;
- maintain spatial tracks and ring buffers in system RAM;
- invoke phone proposal, pose and action stages at lower cadence per active
  candidate;
- invoke the VLM only for bounded candidate/conflict windows;
- allow one current heavy candidate per camera/track and discard stale work;
- expose GPU memory, queue depth, dropped work, per-camera lag and effective FPS;
- emit `UNCERTAIN` on resource exhaustion; and
- never silently substitute an unversioned lower-quality model.

The first slice only needs measured replay performance. Add a load-test fixture
that can simulate twenty timestamped camera streams without claiming twenty
real decoders or twenty-camera accuracy. Record bottlenecks and a capacity
estimate based on measurements.

## Storage model

Prefer existing repository patterns, but preserve these entities explicitly:

- `FactorySite`
- `FactoryModelVersion`
- `FactoryZone`
- `CameraPlacement`
- `CameraCalibrationVersion`
- `TwinReplaySession` / `TwinLiveSession`
- `SpatialTrackObservation`
- `CrossCameraTrackLink` (future/optional)
- existing activity/evidence event reference
- optional `ZoneSensorObservation`

Large raw observation streams may use a time-series/event store if that is
already available. Do not place every video frame or image in MongoDB. Apply
retention to raw positions, trails and evidence separately. Persist immutable
configuration versions so historical replay uses the calibration that existed
when the observation was created.

## Security and permissions

- Enforce company and site scope server-side on every configuration, session,
  event and evidence query.
- Separate view, configure/calibrate, review and export permissions.
- Use read-only camera credentials from a secret store/injected environment.
- Use short-lived authorised evidence references.
- Record audit entries for calibration activation, zone/model changes, exports
  and identity-link corrections.
- Do not expose biometric identity by default.
- Do not log credentials, face crops, unrestricted URLs or image payloads.

## Sequential implementation plan

Do not build all phases concurrently.

### DT-00 — repository and boundary audit

- Locate the actual separate CCTV application/worker and current GRAV event
  adapter.
- Identify existing auth, company/site IDs, WebSocket/SSE conventions, storage
  models and frontend shell route.
- Document exact reuse points and conflicts before coding.

Acceptance: a short written audit names concrete files and confirms the legacy
RTSP router remains unmounted.

### DT-01 — typed spatial contracts

- Add schemas for site/model/camera/calibration and spatial observations.
- Add deterministic validation and idempotency tests.
- Add fixtures for valid, degraded, stale, cross-company and mismatched-version
  events.

Acceptance: invalid or cross-scoped inputs fail closed; valid fixtures
round-trip deterministically.

### DT-02 — calibration and projection

- Implement control-point capture/storage and homography calculation.
- Provide projection functions with calibrated-polygon and quality checks.
- Add unit tests with known image/world points and degenerate calibration.

Acceptance: known points project within the stated tolerance; invalid
calibrations cannot activate.

### DT-03 — deterministic replay service

- Convert existing tracker output to the spatial contract.
- Add a bounded timestamped replay stream with seek/speed support.
- Preserve session/config/model versions and activity references.

Acceptance: two identical replays emit the same ordered event IDs and source
positions; no unbounded queue develops.

### DT-04 — 3D/top-down viewer

- Load the factory/test GLB, cameras, zones and replay stream.
- Render person markers, trails, statuses and diagnostics.
- Add source-video synchronisation and selected-track inspection.

Acceptance: a reviewer can visually follow one known track through a replay,
pause/seek it and inspect the underlying timestamped evidence.

### DT-05 — integration and operational hardening

- Connect the existing activity-event references without reclassifying them.
- Add permissions, audit logging, retention and health metrics.
- Add the twenty-stream load simulation and report measured capacity.

Acceptance: focused backend/frontend tests pass; cross-company access is
rejected; replay remains responsive under the bounded load fixture; measured
limits are documented honestly.

### DT-06 — optional later work, not part of this build

- live RTSP session adapter;
- cross-camera global track fusion;
- authorised employee identity join;
- RuView/CSI zone sensor pilot;
- multi-floor routing and elevator/stair transitions;
- production alert policies.

## Verification checklist

Run the smallest relevant checks after every slice and the combined focused
suite before handoff. At minimum verify:

- schema and company/site-scope tests;
- calibration mathematics and degenerate-input tests;
- deterministic replay ordering/idempotency;
- seek/speed/video synchronisation;
- stale/offline/uncertain UI states;
- bounded browser buffers and worker queues;
- no RTSP credentials or evidence payloads in logs/browser state;
- no activity label is generated by the map renderer;
- no identity is required to render a track;
- accessibility for controls, keyboard selection and non-colour status cues;
- measured browser FPS and memory on a representative replay; and
- measured GPU/queue impact from spatial processing, kept separate from the
  existing phone-use model measurements.

## Delivery requirements

At handoff, provide:

1. a concise Git diff summary grouped by backend, worker and frontend;
2. the exact commands and results for tests/builds;
3. a route/URL and deterministic replay steps for the product owner;
4. the sample factory model and fixture provenance, clearly marked synthetic or
   real;
5. screenshots or a short recording of the replay with camera cones and tracks;
6. measured performance and known limitations;
7. migration/rollback notes; and
8. an updated task/status document without overwriting unrelated active work.

Do not report the feature complete if it is driven only by random markers,
unvalidated coordinates or frame-by-frame labels. The acceptable first result
is a truthful recorded-data digital twin with calibrated positions, inspectable
evidence and clear uncertainty.
