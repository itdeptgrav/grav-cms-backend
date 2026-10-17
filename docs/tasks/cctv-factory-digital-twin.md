# CCTV factory digital twin


## Twin redesign, posture evidence and layout editor — 14 Oct 2026

Contract: `docs/decisions/cctv-twin-posture-layout-contract.md`.

- **Posture from evidence.** The worker no longer labels everyone `SEATED`.
  yolov8n-pose runs on tracked-person crops (one batched call, ~1–2 Hz per
  track), a pure classifier (`scripts/cctv_twin_pose.py`) scores
  standing/seated/crouched from leg geometry, and a per-track smoother adds
  hysteresis and an occlusion hold for people seated behind a table. The
  backend publishes posture only when it came from pose with confidence ≥ 0.5;
  an old worker's hard-coded label becomes `UNKNOWN`. Camera-relative facing
  is converted to a world yaw by the backend.
- **Positions.** Ankles → mapped; feet hidden → estimated below the hips or
  from the box bottom, projected through the same homography and clamped into
  the room as `DEGRADED`. The linear bounding-box proxy is gone.
- **One feed per camera.** A session lease stops a second or stale worker from
  overwriting the snapshot; workers release it on shutdown.
- **Surveyed furniture** lives in the layout (`room.furniture`), is edited in
  the twin (drag, rotate, resize, duplicate, delete, undo/redo, local draft,
  publish with version check) and is admin-only. Detected objects can never be
  saved into it. The old hard-coded table and six chairs are the default,
  marked approximate.
- **Calibration gate.** Activation is refused above 12 px / 0.35 m RMS; the
  setup screen shows per-pair error live and says when four pairs cannot be
  verified.
- **UI.** Full-bleed 3D stage with floating panels; Factory › Room › Camera
  levels; 3D, Plan and simulated Camera views; real frustum coverage and the
  calibrated floor area; anonymous articulated avatars (standing, seated,
  crouched, walking; posture-unknown marker; translucent when estimated);
  seat snapping and table push-out disclosed in the inspector; feed health
  incl. people-only mode; a legend. Dev harness: `/preview/cctv-twin`
  (fixtures; 404 in production).
- **Still open:** standing/walking and multi-person posture not yet measured on
  site footage; pilot worker restart needed to start sending pose; GLB
  humanoid asset (procedural rig for now); server-side layout drafts;
  20-camera scheduler (Task 7) and evaluation set (Task 8).

Status: real-camera registry, first in-app room/camera calibration, and a one-camera live person-observation pilot implemented on 2026-10-14. On 2026-10-15 the pilot added optional administrator-only, direct-face-confirmed identity using the trusted PHONE_DETC gallery.

## PHONE_DETC vision merge — 15 Oct 2026

Contract: `docs/decisions/cctv-twin-face-identity-boundary.md`.

- The two repositories remain separate applications; the twin now has a small
  adapter around the proven PHONE_DETC assets instead of copying its 18k-line
  tracker into the CMS.
- Person detection continues with the exact PHONE_DETC `yolov8m.pt` checkpoint.
- Camera-local tracking now uses its tuned BoT-SORT thresholds and appearance
  association for substantially better ID continuity through close contact and
  brief occlusion.
- InsightFace `buffalo_l` reads the existing gallery without modifying it. Only
  `READY` + `trusted_for_live` employees are candidates, and two direct face
  matches passing distance and inter-person margin gates are required.
- The backend strips identity for every ordinary viewer. Re-verified platform
  administrators see a `face-confirmed` label; otherwise the twin remains
  anonymous and uses only its camera-local track number.
- Identity failure never stops occupancy, pose, calibration or scene objects.
- The live Conference Room worker was restarted on this architecture and is
  publishing successfully.

## In-app Conference Room calibration slice — 2026-10-14

- The digital-twin screen now owns the setup workflow; operators do not edit
  source files or environment variables to map a camera.
- An administrator can select Conference Room (`nvr1:11`), confirm the 10 × 12
  ft room, place the camera by clicking a top-down room plan, and aim it by
  clicking the direction it faces. Height is a slider; tilt and field of view
  live under optional fine-tuning rather than requiring coordinate entry.
- A current camera still is selected locally in the browser and is not uploaded
  or stored. The operator clicks a fixed floor spot in the still and then the
  same spot on the interactive top-down room plan; numbered visual pairs replace
  manual X/Y entry. The resulting pixel/floor pairs are versioned in MongoDB.
- One to three pairs may be saved as a draft. Four or more non-degenerate pairs
  remain a draft until the operator confirms they are exact surveyed floor
  landmarks; confirmed pairs are validated by the backend homography service
  before the camera status may become `CALIBRATED`.
- The singleton twin configuration is stored as a namespaced row in the existing
  `system_settings` collection because the current MongoDB deployment has reached
  its 500-collection quota; the feature does not create collection 501.
- Configuration writes are platform-administrator-only. People with ordinary
  CCTV viewing grants can see the resulting twin but cannot alter geometry.
- A transient hosted-registry failure no longer erases the visible twin. The
  browser retains its last successful registry and the backend can return
  cameras already present in the saved twin configuration, clearly marked as
  stale. The UI must not claim the hosted registry is connected in that state.

Current saved pilot state (14 Oct 2026): the 10 × 12 ft Conference Room and
`nvr1:11` are now `CALIBRATED`. The 3D viewer renders the measured room,
physical camera placement, surveyed furniture approximation, articulated live
occupants and common detected room objects. A local YOLOv8m + ByteTrack worker
reads the real hosted MJPEG stream and publishes anonymous camera-local tracks.
The CMS projects image anchors through the versioned calibration (or marks the
explicit seated-person occupancy proxy as degraded); observations expire after
four seconds and are not persisted.

## Product outcome

Provide a metre-scaled factory view that can replay or display anonymous person tracks, camera coverage and typed activity evidence. The view must not invent employee identity, activity, or position when evidence is missing.

## Implemented

- Protected frontend route: `/cctv/twin`.
- CCTV app home at `/cctv`, with explicit Live cameras and Factory digital twin destinations.
- The twin and CCTV home share the authoritative `GET /api/cctv/access` decision; a direct twin URL cannot bypass the CCTV grant.
- Live-camera hand-off remains backend-owned. The deployed shared-key compatibility value is read from backend-only `CCTV_KEY`, never a `NEXT_PUBLIC_*` variable, UI prop or browser storage. Setting `CCTV_SSO_SECRET` automatically selects personal JWT SSO instead.
- Three.js 3D and top-down factory views.
- The twin reads the authoritative hosted CCTV registry and currently resolves
  32 real cameras, including renamed operational cameras, rather than a copied
  frontend fixture.
- An ordinary person receives only their permitted camera keys; a platform
  administrator receives the complete registry. Live/audio/playback capability
  is carried per camera and neither service nor legacy keys are returned.
- Cameras without supplied placement data report `UNCALIBRATED` with null
  world position. The viewer lists them as `Needs placement` and does not
  invent a marker; owner-supplied trials may be shown as `PROVISIONAL`.
- The synthetic Cam 20 replay, demo people, paths, camera positions and replay
  controls have been removed from the production twin.
- Typed phone-use ontology and observation validation remain available. The
  live adapter publishes person position plus optional direct-face-confirmed
  identity for administrators; it does not claim phone activity or infer
  identity from body appearance.
- `POST /api/cctv/twin/internal/observations` accepts an authoritative detector
  frame from an authenticated service worker (loopback-only without a service
  key in local development). `GET /api/cctv/twin/observations` applies the
  normal CMS/CCTV access boundary and exposes only fresh positions. Identity is
  redacted unless the caller is a re-verified platform administrator.
- The UI polls the bounded snapshot, interpolates stable track positions, and
  removes a person immediately when absent from the latest detector frame or
  after TTL expiry if the worker stops.
- `npm run cctv:twin:person-worker` starts the current one-camera pilot using
  the existing local vision environment and model; CCTV credentials remain in
  the backend environment and are not passed in command-line arguments.

## Conference Room pilot

- The owner supplied a 10 × 12 Conference Room measurement and a frame from
  `nvr1:11`; the current explicit assumption is that the dimensions are feet
  (3.048 × 3.6576 metres).
- The measured room is rendered at scale. The high corner camera placement,
  2.70 m mount height and view direction are frame-derived `PROVISIONAL`
  values, visibly labelled as a draft rather than a calibration.
- Person-coordinate projection is enabled only because this camera has four
  confirmed surveyed floor pairs and a valid homography. The first live run
  mapped one standing person while safely withholding seated people whose
  occluded foot estimates fell outside the surveyed image polygon.
- Backend homography calibration and foot-point projection service.
- Calibration containment uses a convex hull rather than click order, so a
  valid set of pairs cannot become a self-crossing polygon accidentally.
- Rejection of invalid calibration, out-of-area points and unsupported labels.
- Unit coverage for replay selection and spatial projection rules.

## Evidence boundary

The camera registry is real; the current grid is not yet a measured factory
floor. No camera, person or activity is rendered at a factory coordinate until
the site plan and that camera's calibration have passed the spatial gates.

## Next implementation sequence

1. Supply a metre-scaled 2D plan (the minimum) or real factory GLB, with stable
   floor and zone identifiers. A photorealistic scan is not required.
2. Calibrate the remaining cameras with at least four non-collinear image/world control-point pairs and record reprojection error.
3. Publish normalized tracker/activity observations through the typed contract.
4. Add replay storage and a live stream adapter; never couple the viewer directly to detector internals.
5. Add cross-camera identity only after overlap tests; keep identity anonymous by default.
6. Run a privacy, retention and access-control review before employee-linked analytics.

## Acceptance gates for real deployment

- No camera may publish world coordinates without a valid versioned calibration.
- No point outside the calibrated polygon may appear as a precise location.
- Activity remains `UNCERTAIN` when the evidence cascade cannot support a stronger label.
- Calibration and activity confidence are separately visible.
- Twenty-camera operation shares heavy inference and uses candidate-triggered escalation so it fits the 12 GB VRAM target.
# 14 Oct live Conference Room increment

- The live pilot uses YOLOv8m + ByteTrack with CCTV-oriented low-confidence
  recovery, duplicate suppression and bounded occlusion hold.
- The anonymous observation snapshot carries people plus common room objects;
  it stores no frames, faces or employee identity.
- The viewer uses articulated humanoids, a conference table/chair scene and
  class-specific detected-object geometry.
- Setup supports both top-down and interactive isometric 3D placement and
  floor-point pairing.
- Until chair-area floor landmarks are surveyed, seated-person positions are
  explicitly `DEGRADED` occupancy proxies rather than precise coordinates.
- YOLO-World small v2 is integrated as an optional, low-frequency scene-object
  discovery layer with a fixed office vocabulary. It never creates people,
  changes person tracks or overrides spatial calibration. On the current
  low-resolution Conference Room feed it correctly abstains rather than
  publishing weak guesses; room furniture therefore remains the surveyed room
  model until stronger object evidence is available.
- The next useful inference layer is a lightweight pose model run only on
  person crops. It should provide sitting/standing/body-orientation evidence;
  it must not infer employee identity or unsupported activities. Continuous
  VLM and monocular-depth inference remain out of scope for the 12 GB,
  twenty-camera target.

