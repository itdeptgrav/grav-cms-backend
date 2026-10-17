# CCTV twin: posture evidence, feed lease and surveyed layout contract

**Status:** accepted · 14 Oct 2026
**Applies to:** `services/cctv/factoryTwin*.js`, `routes/cctvSso.js`,
`scripts/cctv-twin-person-worker.py`, `grav-cms/components/cctv/**`

## Context

The Conference Room pilot worked end to end but three things were decided
implicitly in code and were wrong or fragile:

1. The worker labelled **every** person `SEATED` because "this is a conference
   room". That violates the plan's rule that posture comes from evidence or is
   `UNKNOWN`.
2. The out-of-polygon "occupancy proxy" mapped a pixel linearly across the
   bounding box of the image control points. That ignores perspective, so a
   seated person far from the camera landed in the wrong part of the room.
3. Furniture was hard-coded in the React component for `conference-room`, so it
   could not be edited, was invisible to the backend, and could not be told
   apart from detector output except by colour.

A fourth gap: any process posting for a camera overwrote the snapshot, so two
workers (or a stale one) made the person count flicker.

## Decisions

### 1. Posture is typed evidence

A worker track may carry:

```json
{
  "posture": "STANDING | SEATED | CROUCHED | UNKNOWN",
  "postureConfidence": 0.0,
  "postureSource": "POSE | NONE",
  "orientation": { "relativeYawDeg": 0, "confidence": 0.0 },
  "anchorMode": "POSE_ANKLES | POSE_HIP_ESTIMATE | BOX_BOTTOM | OCCUPANCY_PROXY",
  "keypointVisibility": 0.0
}
```

- The backend publishes a non-`UNKNOWN` posture **only** when
  `postureSource === "POSE"` and `postureConfidence >= 0.5`. Anything else
  (including the old worker's hard-coded `SEATED`) becomes `UNKNOWN`. Old
  workers therefore stay accepted; they just stop asserting posture.
- `orientation.relativeYawDeg` is measured **relative to the camera**: `0` means
  the person faces the camera, `+90` faces image-right, `±180` faces away. The
  backend, which knows the camera's world position, converts it to a world yaw
  (`visual.orientationDeg`, same convention as camera yaw: facing
  `(sin yaw, cos yaw)` in x/z). Below confidence 0.4 no world yaw is published.
- The worker smooths posture with hysteresis per track (state changes need a
  margin and two consecutive pose updates) and decays to `UNKNOWN` when pose
  evidence is older than a few seconds.

### 2. Anchors decide position quality

| `anchorMode` | Meaning | Best quality |
| --- | --- | --- |
| `POSE_ANKLES` | ankle keypoints, i.e. the real floor contact | `GOOD` |
| `BOX_BOTTOM` | bottom of a box believed to include the feet | `GOOD` |
| `POSE_HIP_ESTIMATE` | feet hidden; floor point estimated below the hips from posture | `DEGRADED` |
| `OCCUPANCY_PROXY` | feet hidden, no pose; box bottom used as a rough proxy | `DEGRADED` |

Points inside the calibrated image polygon go through the homography as before.
For the two estimate modes, a point **outside** the polygon is still projected
through the same homography (it is valid on the whole floor plane below the
horizon), rejected if it lies beyond the horizon or more than 0.75 m outside the
room, and otherwise clamped into the room as `DEGRADED`. The linear bounding-box
proxy is removed. `BOX_BOTTOM`/`POSE_ANKLES` outside the polygon take the same
estimate path (amended 15 Oct; they were rejected with `OUTSIDE_CALIBRATED_AREA`,
which made people at the frame edges flicker between placed and absent as their
anchor switched between feet and hips). `OUTSIDE_CALIBRATED_AREA` remains for
callers of `projectFootPoint` itself.

### 3. One feed per camera (session lease)

The first session to post for a camera holds a lease. A different `sessionRef`
is refused with `409 FEED_SESSION_CONFLICT` while the holder has posted within
the live TTL (4 s). A frame with `"final": true` releases the lease and clears
the camera immediately (the worker sends one on shutdown). The worker may send a
small `pipeline` health object (model names, `poseEnabled`, `peopleOnly`,
timings); the backend whitelists its fields and returns it, with the frame age,
from `GET /api/cctv/twin/observations` as `feed`.

### 4. Surveyed furniture lives in the layout

Each room in `layout.rooms[]` may carry `furniture[]`:

```json
{ "id": "chair-1", "type": "CHAIR", "label": "Chair", "xM": 1.2, "zM": 0.6,
  "rotationDeg": 0, "widthM": 0.5, "depthM": 0.5, "heightM": 0.9,
  "provenance": "SURVEYED | APPROXIMATE" }
```

- Positions are room-local metres from the room origin, centre of the item.
- `PUT /api/cctv/twin/layout` (platform administrators only) replaces one room's
  furniture with `{ roomId, furniture, baseVersion }`. A stale `baseVersion` is a
  `409 TWIN_CONFIG_CONFLICT`. The configuration version increments and the actor
  is recorded, like calibration saves.
- `DETECTED` is **not** an accepted provenance for saved furniture: detector
  objects stay in the live snapshot and can never rewrite the surveyed layout.
- Saving room measurements/calibration preserves the room's furniture.
- A stored configuration whose Conference Room has no `furniture` key gets the
  previous hard-coded table and six chairs, marked `APPROXIMATE`, so nothing
  disappears on upgrade.

### 5. Calibration quality gate

Activation is refused when the inverse reprojection RMS exceeds 12 px or the
forward floor RMS exceeds 0.35 m, with a plain-language message. The saved
calibration also carries per-pair floor residuals and the calibrated floor
polygon so the UI can show where precise mapping is valid. With exactly four
pairs the fit is exact and the error says nothing; the UI says so and asks for a
fifth point.

## Rendering rules that follow (frontend)

- `UNKNOWN` posture renders as a posture-neutral marker (upper body over a
  floor ring), never as a standing or seated body.
- A `SEATED` person within 0.8 m of a surveyed/approximate chair is drawn on
  that chair, facing the chair's direction, and the inspector states the offset
  from the mapped point. A person whose mapped point falls inside a solid
  footprint (table, cabinet, machine) is drawn at its nearest edge, also
  disclosed. These are display reconciliations; the published observation is
  unchanged.
- Detected objects render as amber outlines labelled "detected", never as solid
  furniture.

## Consequences

- The running pilot worker must be restarted to send pose evidence; until then
  people appear with `UNKNOWN` posture rather than a false `SEATED`.
- The 12 GB / 20-camera budget is unaffected by this change: pose runs on person
  crops at about 1–2 Hz per active track and is skipped entirely under
  `--no-pose` (people-only mode), which the UI shows.

## Implementation notes (backend + worker, 14 Oct 2026)

Ambiguities resolved while implementing; the frontend can rely on these.

- **Default chairs face the table.** The old component turned the two end
  chairs by -90/+90 about three.js +Y, which with its backrest-at-local-z
  model pointed them *away* from the table. Under this contract's facing
  convention (`rotationDeg` = yaw the seated person faces, facing
  `(sin, cos)` in x/z) they are stored as `chair-5` (table's -x end) = `90`
  and `chair-6` (+x end) = `-90`; `chair-1/2` = `0`, `chair-3/4` = `180`. The
  table's `heightM` is `0.76` (top surface height).
- **Anchors.** A missing or unrecognised `anchorMode` is treated as
  `BOX_BOTTOM`, the strictest mode. An estimate mode inside the polygon goes
  through `projectFootPoint` with quality capped at `DEGRADED` and confidence
  at 0.5, `method: "FLOOR_HOMOGRAPHY"`; outside it uses `projectFloorEstimate`,
  `method: "FLOOR_ESTIMATE"` (confidence <= 0.35). Objects are always
  `FLOOR_ESTIMATE`. `projection.clamped` ignores sub-micrometre float noise.
- **Visual.** `postureSource` echoes the worker (`POSE` stays `POSE` even when
  the posture is gated to `UNKNOWN`); `postureConfidence` is the clamped value
  when `POSE`, else 0. `orientationConfidence` is 0 whenever `orientationDeg`
  is null. `keypointVisibility` is null when not sent.
- **Lease.** The lease is checked before the calibration lookup, so a
  holder's `final` frame works even if the camera was de-calibrated. A
  `final` from a non-holder while the lease is live is a 409. The ingest
  response for a final frame carries `released: true`.
- **Feed.** `feed.lastFrameAt` is the server's receipt time. A feed stays
  readable with `live: false` after the TTL until a `final` frame or a server
  restart. `GET /twin/observations` always returns `feeds` (a map by camera
  key): every visible camera with a feed when no `cameraRef` is given (with
  `feed: null`), or just the requested one. A non-administrator without
  `cameraRef` receives only granted cameras' observations, objects and feeds.
- **Layout save errors.** `ROOM_NOT_FOUND` (400), `TWIN_CONFIG_CONFLICT` (409,
  stale `baseVersion` or a concurrent save, checked again on write),
  `FURNITURE_LIMIT`, `FURNITURE_OUT_OF_ROOM`, `FURNITURE_PROVENANCE_INVALID`
  (also for a missing provenance), and `INVALID_FURNITURE` for everything else.
  Labels over 60 characters are refused, not truncated; unknown item keys are
  dropped. Re-saving measurements keeps other rooms as well as furniture.
- **Calibration gate.** The message names the pair with the largest residual,
  but says that one bad pair can pull the others off too: a least-squares fit
  spreads an outlier's error, so the largest residual is not always the
  faulty pair.
- **Worker.** Pose runs only on ByteTrack-tracked boxes. A pose result whose
  legs are hidden (common behind a table) is not posture evidence, so such a
  person decays to `UNKNOWN` after 5 s rather than keeping a guess. The
  frontal shoulder-width/torso ratio is 0.55 (measured on yolov8n-pose
  keypoints), not the anthropometric 0.75; re-measure on site footage.
- **Occlusion hold (added after a live check, 14 Oct).** On the real
  Conference Room feed a seated person's legs are hidden behind the table in
  roughly half the pose samples, so the plain 5 s decay flickered them to
  `UNKNOWN`. `PostureSmoother` now keeps a *confirmed* posture alive while the
  shoulder midpoint stays within 0.35 torso lengths of where it was when the
  posture was last seen with legs (standing up lifts it by about a torso),
  for at most 90 s, with confidence easing down so the backend's 0.5 gate
  ends the hold. No shoulders, rising shoulders or an expired hold → the
  ordinary decay to `UNKNOWN`.
- **Crouch threshold.** From a 2.7 m mount a seated person's shins foreshorten
  to about half a torso, which the first crouch rule (ankle within 0.4–0.6 T
  of the hips) mislabelled. A crouch now needs the hips within 0.2–0.35 T of
  the ankles.
- **Measured on the live feed (MacBook CPU, 640×360 substream, one seated
  person, 16 samples ≈ 1–2 s apart):** YOLOv8m detect+track median ≈ 172–187
  ms, yolov8n-pose on the crop ≈ 10 ms, peak RSS ≈ 660–690 MB. Posture held
  `SEATED` at 0.99–1.00 on all 16 samples after the two fixes above (before:
  `UNKNOWN` on 9 of the 15 samples with a person in view). Not yet measured: a standing/walking person, several
  people, or the 12 GB GPU target.
- **General-position gate (14 Oct, evening).** The saved Conference Room
  calibration v5 had three of its four floor points along the left wall
  (x ≈ 0.01–0.05 m). Four points fit any such set "exactly", so it passed, but
  every pixel off that wall mapped onto it or beyond the horizon — a seated
  person in plain view was rejected and the twin showed an empty room. New
  rule (backend `generalPosition`, mirrored in the setup UI): the best
  four-point subset's smallest triangle must be ≥ 5% of the point spread, on
  the floor and in the image. Saves are refused with the offending points
  named; an already-saved degenerate calibration places nobody
  (`CALIBRATION_UNRELIABLE`).
- **Seen but not placeable.** A person the worker reports but the twin cannot
  place is no longer dropped: `GET /twin/observations` returns them under
  `unpositioned` (camera, track, gated posture, reason — never a coordinate),
  with the same TTL and grant filtering. The UI counts them, lists them, labels
  the camera "N in view · position unknown" and offers Re-map.
- **Mapping still.** `GET /api/cctv/twin/still?cameraRef=` (administrators)
  returns one JPEG cut from the same MJPEG stream the worker reads, so
  calibration pixels match the detector's; a viewer screenshot may be
  letterboxed or rescaled. Not stored.
- **Camera setup by room alignment (14 Oct, night).** Hand-pairing floor
  points proved unintuitive and let the mount and the points silently
  disagree. The default setup (`components/cctv/twin/TwinCameraSetup.js`) now
  draws the measured room through a virtual camera over the live frame; the
  operator drags/zooms until the floor edges match, and the floor pairs are
  generated from that camera (`twinCameraMatch.mjs`, `method:
  "ROOM_ALIGNMENT"`). The server fits and gates them like any pairs. Measured
  check marks (`checkPoints`) are compared with the fit: any mark more than
  0.35 m off refuses the save (`CHECK_POINT_DISAGREES`); with no mark the
  calibration is `verified: false` and every live position is capped at
  `DEGRADED` (`projection.unverified`). Camera roll is stored in
  `rotationDeg.z`. Hand pairing remains as "Manual floor points".
- **Still people stay still (14 Oct, late).** On the live feed a seated
  person's box bottom jumped tens of pixels per frame and the twin showed them
  wandering. The worker now runs every track's floor anchor through
  `AnchorStabilizer` (dead-band 0.12 box heights, slow drift inside it, a move
  must persist two frames or be ≥ 3 bands), and the twin holds the drawn
  figure inside a 0.2 m (mapped) / 0.4 m (estimated) dead-band. The
  posture-unknown marker is now a plain column, not an upright torso, because
  operators read the torso as "standing".
- **Rigged avatars, gestures and confirmed objects (15 Oct).**
  - *Body points.* The worker publishes the 17 smoothed COCO keypoints per
    tracked person (`pose2d.keypoints`, frame px; the server scales them to
    calibration px and stores nothing). The twin lifts them to 3D limb
    directions with a scaled-orthographic, known-limb-length lift through the
    saved camera (`twinPoseLift.mjs`); a limb drives the rig only above
    keypoint confidence ≈ 0.5, else the posture template stays. From a high
    camera a hanging and a forward-reaching forearm draw the same 2D line, so
    the forward reading needs the `HANDS_FORWARD` gesture or phone evidence.
  - *Gestures* (`HAND_AT_HEAD`, `HANDS_FORWARD`, `HAND_RAISED`) are 2D arm
    geometry with hysteresis. They are shown as what the arms do, never as an
    activity; `activity` is unchanged and still `UNCERTAIN` by default.
  - *Phone in hand* (`interactions: PHONE_IN_HAND`) needs a phone detected on
    the upscaled person crop, confirmed in 3 of the last 5 checks, touching a
    wrist with keypoint confidence ≥ 0.5. Not yet measured with a person in
    the room; it abstains rather than guesses.
  - *Room objects.* On the 640×360 substream the COCO detector called a pink
    plastic bag a "potted plant" at 0.59 and missed an open laptop; the
    backend's main RTSP stream did not answer from the worker host. So objects
    are published only after confirmation in 3 of the last 5 scans (COCO every
    2 s plus YOLO-World every 8 s as a second vote), from a portable-item
    whitelist (laptop, keyboard, mouse, monitor, phone, cup, bottle,
    backpack); chairs and tables come from the surveyed layout only. Desk
    items are drawn on the surveyed tabletop their camera ray lands on.
    Raising the NVR sub-stream resolution (e.g. to 1280×720) is the most
    direct way to make object evidence useful.
- **Desk items are placed, not detected (15 Oct).** With someone absent and
  the open laptop and keyboard plainly on the Conference Room table, neither
  YOLOv8m (COCO laptop/keyboard) nor YOLO-World detected them in 5 live frames
  even on a 2.5× upscaled crop of the table at confidence 0.1. They are
  therefore layout items: `LAPTOP`, `KEYBOARD`, `MOUSE`, `MONITOR` join the
  furniture types with an optional `elevationM` (0–3 m; the tabletop), placed
  and dragged in the layout editor, drawn in surveyed/approximate styling. A
  live detection within 0.6 m of a placed item of the same type is treated as
  that item and not drawn twice.
- **Smooth movement, no pop-in/out (15 Oct).** Display only; observations are
  unchanged. Accepted positions become timed keyframes played back 0.8 s
  behind real time on a centripetal Catmull-Rom curve
  (`twinMotion.mjs` `MotionTrack`); speed and heading come from the curve and
  the stride advances by distance walked (0.68 m per step), so legs match the
  motion. A track missing from the feed is held 1.2 s, then walked to the
  nearest DOOR along an A* path around solid furniture and faded beyond it,
  or faded in place if no door is near; it is labelled "left view" and is not
  counted. A new track within 1.2 m of a figure that left < 4 s ago takes
  that figure over (tracker id switch). A new track first seen within 1.6 m
  of a door walks in from outside it.
- **Bodies are solved from the detector, not posed (15 Oct).** Display only;
  the observation contract is unchanged. The avatar is one skinned mannequin
  (`twinRig.js`, 20 bones) whose joints all come from the observation's
  `pose2d` keypoints, solved in 3D by `twinSkeleton.mjs` `PoseSolver`:
  scaled-orthographic lifting with fixed bone lengths, the hidden depth taken
  along the camera's ray **to that person** (not its optical axis — at the
  edge of an 82° lens the axis tilted upright torsos by 17–24°; the ray
  brings it to 2–5°), aimed at the measured pelvis height by a second pass.
  Pelvis height: ankles if seen, else the hip and head rays over the floor
  point (0.6/0.4), else the previous value. Leg depth choices are scored
  against that height; hidden legs follow from it by IK (feet on the floor);
  hidden arms hold their last seen direction, else hang. Gestures and the
  phone supply only evidence the points cannot (forearms along the view ray;
  which hand holds the phone) — the gesture arm templates, posture templates
  and typing tap are gone. Poses are One-Euro filtered per joint, keyframed
  and played back 0.8 s behind real time (the position's delay) on a monotone
  cubic, so steady motion keeps its speed through keyframes and nothing
  overshoots. Two disclosed exceptions: walking legs follow measured speed
  and stride (≈3 Hz pose cannot sample steps), and an observation with posture
  but no points wears a neutral body at that posture's pelvis height. Posture
  UNKNOWN with no points is still a column. The worker's `--pose-interval`
  default is now 0.3 s and the twin polls every 500 ms.
- **Steadier people, detailed objects (15 Oct, evening).** Measured on 2,495
  live status lines of the Conference Room worker: 24% had someone refused as
  outside the mapping polygon (the room alignment's points span x 113–569 of
  640 px, so the frame edges were outside), 284 placed↔refused flips; 64
  tracker ids for ~3 people, many alive < 20 frames; 162 frames with untracked
  `det-*` boxes. Changes: (1) foot anchors outside the polygon take the
  estimate path (section 2, amended); (2) the worker's `TrackStitcher` gives a
  new tracker id appearing where a lost one was last seen (≤ ~0.6 box heights,
  similar size, within the 6 s hold) the lost one's id, and a held copy that
  overlaps someone seen this frame is dropped; (3) untracked boxes are no longer
  published. Room objects come from one Original still every 15 s
  (`--detail-interval`) via the CCTV app's `GET /snapshot/<i>?quality=original`
  (patch in `docs/handoff/patches/`), confirmed 2 of the last 3, boxes mapped
  back to stream pixels; until that endpoint exists the worker detects it
  (no `X-Frame-State: live`) and keeps its stream-frame scans. People, pose and
  phone checks stay on the Standard stream.
- **Head anchor, rolling chairs, Original stream (15 Oct, late morning).**
  After the restart the remaining refusals (59 of 349 lines, `OUTSIDE_ROOM`)
  were one person cut off by the bottom of the frame: their box bottom is the
  frame edge, not the floor. New anchor `POSE_HEAD_ESTIMATE` (worker sends it
  when the box touches the frame bottom and a head point is visible, with
  `anchorHeightM` from posture: nose 1.2 m seated, 1.6 m standing, 1.4 m
  unknown; shoulders 0.25 m lower): the head pixel's floor hit F is pulled
  toward the point below the camera by (H − h)/H. Always DEGRADED (≤ 0.35).
  Display only: a seated person is no longer moved to a chair more than
  0.35 m away; the nearest free chair within 1.6 m is drawn under them instead
  (chairs roll) and stays where it was last sat on until the layout item is
  edited; with no chair in reach one is inferred under them, facing the
  nearest table, and disclosed as inferred. The worker now reads the camera's
  main stream by default (`--quality original`: `quality=original&prio=full`,
  through cctv.grav.in at most 1280×720 at 4 fps, one NVR connection held while
  it runs); the backend scales all pixels from `frameSize` to the 640×360
  calibration, and detail stills are skipped as redundant.
- **Original actually reaching the worker (15 Oct, 10:35).** The CCTV app was
  serving Original (2560×1440 → 1280×720, 4 fps, LIVE) but the worker logged
  640×360: `cv2.VideoCapture` fixes an MJPEG stream's size at its first frame —
  the 640×360 "switching to Original" stand-in — and rescales every later frame
  to it. The worker now reads the multipart stream itself
  (`scripts/cctv_twin_stream.py` `MjpegReader`): each JPEG decoded at its own
  size, parts filtered by the app's `X-Frame-State` (live; a labelled Standard
  stand-in only after 10 s without live frames; never status or cached), newest
  frame only, verified TLS via certifi. Checked live: 1280×720 `live` frames;
  Original and Standard show the same view (phase correlation shift 0.0 px), so
  the 640×360 calibration holds. Same moment, yolov8m: Standard found 1 person,
  laptop 0.49, two bottles and a "suitcase"; Original found the person 0.94, both
  laptops (0.94, 0.84), both mice, the keyboard, the handbag, five bottles and
  the chairs (0.77, 0.48, 0.34).
- **Detected chairs, bags; why posture stays unknown (15 Oct, 10:45).** On a
  live Original frame the seated man behind the table has nose, eyes,
  shoulders, elbows, wrists and hips seen, knees and ankles hidden;
  `classify_posture` needs knees, so all scores are 0. A height test (hip and
  nose rays a torso apart) put his pelvis at 0.02 m — the saved camera model's
  vertical geometry is off: projected through it, the floor outline matches the
  frame but the back-wall corners lean 0.2 px/px where the real ones are
  vertical, and the layout table is ~40% wider than the real one. A fit to the
  measured corners and wall bases cannot separate a 3.66 m room seen at 68°
  from a 5.4 m room at 55° without one measured length, so height-based
  posture is not attempted until the room depth and table size are measured.
  Chairs are now detected (COCO + YOLO-World, ≥ 0.35, 3-of-5, boxes cut by the
  frame bottom skipped) and published as `CHAIR`; the twin moves the nearest
  layout chair within 1.6 m to each one (ignoring detections inside a table
  footprint), draws unclaimed ones as detected chairs, seats people on a seen
  chair within 0.6 m and never rolls a seen chair. `HANDBAG` added (COCO
  handbag and "suitcase"). Estimated bodies are drawn at ~0.8 opacity instead
  of 0.5.
- **Camera refit from room lines; bodies kept out of furniture (15 Oct, 11:00).**
  Camera NVR1:11 refitted from the live Original frame by vanishing points:
  1,689 LSD segments, 103 assigned to the room's three axes (27 across, 50
  along, 26 vertical); the three focal-length estimates from VP pairs agree
  (1,004–1,069 px, 62–65° HFOV). A fit of yaw/tilt/roll/FOV/position to the
  VPs plus the measured wall-base lines, with camera height fixed at the
  entered 2.70 m and room width left free, returned a width of 3.029 m against
  the entered 3.048 m — independent confirmation — and a room depth of
  4.14–4.15 m (13.6 ft, not 12). Saved through `saveFactoryTwinConfig` as
  version 7 (ROOM_ALIGNMENT, 12 generated pairs, still unverified: no measured
  check mark): x 2.937, z 4.072, height 2.700 m, yaw −147.35°, tilt −35.73°,
  roll −10.34°, HFOV 64.97°, room 3.048 × 4.152 m. The table top projected
  onto the 0.75 m plane through it measures 1.13 m wide (edges at x 1.14 and
  2.27 m), far edge z 1.05 m; saved as layout version 8 (length kept). Previous
  row (v6) backed up before the write. Twin: a seated person's body takes the
  seat's 0.5 m pelvis height over camera-derived heights; `keepOutOfSolids`
  straightens a torso that would enter a tabletop, rests hands on it and keeps
  knees under it; a person with posture unknown whose hips are seen and legs
  hidden within 0.7 m of a table with a chair in reach is drawn "probably
  seated" (disclosed in the inspector); a standing person pushes an empty chair
  0.45 m clear; a rolled or inferred chair is never placed inside a table.
- **Light physics (15 Oct, 11:30).** Display only. Each frame
  `twinPhysics.mjs` `separate()` resolves people (0.24 m circles), chairs
  (0.28 m) and solid furniture (their footprints) in four rounds of pairwise
  separation: people apart, a seated person weighted 10× heavier than a walker;
  a standing person out of a table, a seated one allowed to within 0.08 m of
  its edge; an empty chair takes 80% of a person/chair overlap, the chair a
  person sits on is skipped; chairs apart and at most 0.12 m under a table.
  Figures and chairs ease toward the corrections (rate 6/s, capped 0.6 m), so
  nothing jumps; chair pushes survive furniture rebuilds. The torso guard
  (`keepOutOfSolids`) uses the corrected position.
- **Decided over seconds, not frames (15 Oct, 11:30).** Live log: phantom
  tracks (365, 644, 840) appeared for 10–30 status lines at a time; one was a
  person walking in the corridor, seen through the glass door, whose feet land
  just beyond the back wall and were pulled inside by the 0.75 m estimate
  tolerance. Changes: seen feet (POSE_ANKLES/BOX_BOTTOM) outside the polygon
  get a 0.15 m room tolerance, estimates keep 0.75 m; the worker admits a
  track only after 2 s seen in ≥ 60% of frames with mean confidence ≥ 0.4
  (`TrackAdmission`, `--admit-seconds`); a posture change must hold 3 s
  (`--posture-dwell`); in the twin each bone's direction is the per-component
  median of its observed directions over the last 3.5 s (`StablePose`), then
  limited (`limitJoints`: torso ≤ 30° seated / 40°, upper arms and forearms
  not behind the body, not above the shoulder without HAND_AT_HEAD /
  HAND_RAISED); "probably seated" holds 6 s. CPU: face scans every 3 s,
  room-object scans every 4 s, phone checks every 2 s.
- **Closer to the picture (15 Oct, 11:45).** Clothing colour: the worker
  takes the median colour of the torso (shoulders–hips, shrunk 25%) and thighs
  (hips–knees) on each pose update, keeps the median of the last 9 per track,
  and sends `appearance: { shirt, trousers }` as `#rrggbb` only; the backend
  accepts nothing else under it (no images, no crops); figures wear it, else
  their track-id tint. A deliberate change from "colour carries no identity":
  clothing colour can help a viewer recognise someone, so it is limited to two
  colours. Hands: a wrist within 0.3 m of a detected mouse, laptop, keyboard or
  phone (and within 0.35 m in height) reaches it by two-bone IK, elbow down and
  out. Room-object scans run at 1280 px (cups, mice, phones); `NOTEBOOK` (COCO
  book) added; "probably seated" now needs hidden feet (not knees) and a table
  within 1.0 m; laptop screens render dark, the handbag leather-brown.
  Objects appear 8–12 s after a worker start (3 sightings 4 s apart).
- **Ground floor from drawing A-101 rev A (15 Oct, 12:00).** 22 rooms
  generated by `services/cctv/factoryFloorPlan.js` from the drawing's clear
  inside sizes and dimension chains (9" outer walls, 4½" partitions), which
  reproduce its overall 90'-2½" × 77'-6½" and the 61'-6" production width
  (pinned by `test/cctv/factory-floor-plan.test.js`). Finishing & Packing is
  two rooms joined by an opening (its 3'-5" step); Toilet and Management are
  rooms drawn inside Sir's Office and Production (`nested`). Rooms may now carry
  `openings: [{ side, fromM, toM }]` (open joins: passages, the F&P step, Tree
  Space onto the road) and every DOOR cuts a doorway in each wall within
  0.35 m of it. All rooms are APPROXIMATE (the drawing is "not to scale";
  verify on site). Saved as layout v9 by `scripts/apply_factory_floor_plan.js`
  (dry run by default, compare-and-set, furniture through the layout
  validator); the Conference Room — calibrated, not on this drawing — is
  unchanged, and the floor sits 6.05 m to its right (`--origin-x`).
- **Natural poses, chosen by the camera (15 Oct, 12:15).** Owner: poses
  looked broken (an arm straight up, a body folded over the table) — too
  flexible to noisy keypoints. Bodies are now natural by construction
  (`twinSkeleton.mjs` `NaturalPose`): a seated stance on the seat (0.5 m) or a
  standing one; torso lean from the camera clamped to −5°…20° seated / 15°
  standing and smoothed; each arm one of a small set of natural poses (seated:
  forearm on table, writing, in lap, hand at chin, phone at ear, at side,
  raised; standing: at side, hands in front, on table, chin, ear, raised), the
  one whose projection through the camera best matches the detected elbow and
  wrist relative to the shoulder, plus a prior for unusual poses and gesture
  evidence (phone side → ear; HAND_AT_HEAD → chin/ear; raised only with
  HAND_RAISED). An arm switches only when another pose fits clearly better
  for 1.5 s. Elbows come from the two-bone reach (real bone lengths, never
  above the shoulder). Hands-on-objects applies only to a hand already at the
  table, within 0.2 m. This replaces per-joint lifting (`StablePose` and
  `limitJoints` remain in the module, unused by the avatar).
- **Placing people whose legs are hidden (15 Oct, 12:30).** Debugged on a
  70 s capture of the live camera (`--no-publish --dump`, face identity off),
  run through the backend's own ingest and replayed in the preview
  (`?scenario=replay`). The man at the far end was drawn standing at the back
  wall: with knees and feet behind the table his anchor was the box bottom —
  the table edge — whose floor projection lands at the wall (z 0.0–0.46 m),
  1 m from the table, so "probably seated" missed. New anchors place a body
  point at its posture height through the camera (`projectHeadEstimate`, a
  generic point-at-height projection): `POSE_SHOULDER_HEIGHT` (shoulders
  1.0 m seated/unknown, 1.45 m standing) when feet and knees are hidden and
  both shoulders seen, else `POSE_HIP_HEIGHT` (hips 0.5 m / 0.95 m). On the
  capture: hips at 0.5 m put him at z 0.66–1.04 (behind the table's far edge
  at 1.05); shoulders at 1.0 m agree to a 6 cm median and were seen in all 138
  frames vs 55 for hips; the head at 1.2 m landed 0.4 m too close (he leans
  over his phone). Display: detected-object labels show only on hover or
  selection, their rings are lighter and smaller, and room names are hidden in
  the camera's own view.
- **Observation study, footage vs twin (15 Oct, 13:00).** Two captures (200 s
  and 170 s) of the worker's output (capture-only, no identity) replayed
  through the backend, with a live still every 15 s as ground truth.
  Found and fixed: (1) object scans and phone-crop scans ran on the same YOLO
  instance as `model.track(persist=True)`; Ultralytics routes later
  `predict()` calls on that instance through the attached tracker, so a scan
  returned only boxes the person tracker kept (1 of 22 on a live still) — room
  objects collapsed from 15 to 3 when a third person came in, and objects fed
  the person tracker. Objects now use a separate instance; after the fix
  objects held at 10–13 and the feed doubled to 2.2 frames/s. (2) Mixed
  anchors made a seated person jump 0.7 m; the anchor order is now feet →
  shoulders → hips → head (cut off) → older estimates, with no knee
  condition. (3) A person cut off by the frame flipped seated/standing; any
  height anchor now counts as legs unseen for "probably seated". (4) Hand at
  the face was never shown: from above a hunched person's face is level with
  the shoulders, so the chin pose's projection tied with "on table" (0.29 vs
  0.31); the wrist-to-nose distance in torso lengths is now evidence (< 0.7
  for, > 1.1 against). (5) Chairs wandered up to 1.7 m: detected chairs whose
  estimate was clamped into the room (base hidden behind a sitter) are
  ignored, a detection only moves a layout chair within 1 m, a seated person
  takes a seen chair within 0.9 m (leaning over the table puts the shoulders
  ~0.6 m in front of the seat), and stays on a chair within 0.5 m. (6) CCTV
  washes shirt colour out; saturation ×1.4 on display. Result on the second
  capture: the far-end sitter drawn with 0.00 m spread over 167 s, no seated
  flips; the other jumps only when he stood up and left; 2 track ids for 2
  people; the person in the corridor behind the glass door never appeared.
- **People cut off by the bottom of the frame (15 Oct, 14:30).** A man sitting
  at the near end, under the camera and seen from behind, was shown as an
  unknown with no body. His box ran off the frame bottom. The pose model never
  saw his face, scored a shoulder at 0.30 and "saw" hips around his arms, so
  over 40 frames his anchor flipped between shoulders (17), proxy (16), hips
  (6) and head (1). New anchor `BOX_TOP_HEIGHT`: the top-centre of the box,
  which is the crown of the head and is seen even from behind, placed at
  crown height by posture (1.3 m seated/unknown, 1.75 m standing; accepted
  0.8–2.0 m; method `CROWN_HEIGHT_ESTIMATE`, DEGRADED). It is the first choice
  whenever the box touches the frame bottom. Anchor methods are also now held
  per track (`AnchorModeHold`, 1 s): a track keeps its method while it is
  still usable and changes only after another method has been best for 1 s.
  Live, people getting up at the near end had flipped ankles / shoulders /
  crown nearly every frame. The pixel smoother restarts when the method
  changes, so two different body points are never blended. Result over 60 s
  live: the near-end man had 105/105 frames on the crown and 0 switches; he
  was placed at (1.86, 3.23), 6 cm past the table's near edge, within a
  12 × 13 cm box. In the camera view the twin shows his head and shoulders at
  the frame bottom, as the footage does.
- **Footage vs twin, side by side (15 Oct, 15:50).** The twin's camera view was
  recorded while replaying a live capture, next to the real frames from the
  same moment. Fixed:
  - **Standing people drawn seated and thrown back.** Two causes. (1) A knee
    guessed behind a table edge (0.4–0.5) read a man standing bent over the
    table as SEATED 0.9. Posture now needs knees at 0.5 or more, and evidence
    is weighted by the knee. (2) The 3 s dwell never confirmed his walk-in
    (1.4 s of full legs). Strong evidence (0.75 or more for 1 s) now confirms
    early, so the occlusion hold keeps him standing once his legs vanish.
    STANDING → SEATED also needs the shoulders to drop by the hold tolerance,
    since nobody sits without their shoulders lowering. A confirmed posture
    reports at least 0.75, easing below 0.5 only after ~30 s without leg
    evidence, after which the worker sends it as `postureHint`.
  - **Body heights while unconfirmed.** The worker places by the posture the
    evidence leans to (`PostureSmoother.lean`) and sends it as `postureHint`.
    The backend passes it through; the twin never draws "probably seated"
    against a STANDING hint and labels it "probably standing". A standing
    person with feet hidden is placed by the hips (0.95 m), not the leaning
    shoulders. Reported feet that put a standing person's hips below 0.75 m
    are a guess, and the hips place them instead (`heightAbovePoint`).
  - **Lean.** Up to 50° standing and 35° seated (it was 15°/20°). Standing, a
    clear lean of more than 20° turns the body to face it. Seated with
    shoulders or crown seen over the table, the seat goes back to 0.28 m from
    the edge and the torso leans to the seen point (`leanDeg`).
  - **Seats.** A person is moved onto a chair only within 0.25 m (layout) or
    0.45 m (seen), and never when placed from the top of the head. Otherwise
    the chair rolls to them. A rolled chair faces the nearest table edge, or
    the laptop, keyboard or monitor within 0.9 m of the sitter's shoulders,
    and remembers that heading.
  - A "person" must average detection confidence 0.5 to be shown (a hand on a
    laptop at the frame edge passed at 0.44).

  The worker reads Original through cctv.grav.in at 1280×720: the CCTV app
  caps every tunnel (remote) Original viewer at `CCTV_REMOTE_ORIGINAL_MAX_W`
  = 1280. The source is 2560×1440. Detection on a full-quality still gave the
  same people and points, so resolution did not cause these errors.
- **Issues from the side-by-side, and steadiness (15 Oct, 16:20).** The owner
  accepts up to ~5 s of delay but not change every second. Fixed:
  - **Steadiness.** `twinSteady.mjs` `SteadyPeople`: each person is drawn at
    the median of the last 3 s and moves only beyond 0.2 m; someone walking
    (more than 0.6 m in the window) is followed by the last second's median. A
    person missing from an update is held 3 s. Arm poses switch only after 3 s
    (was 1.5 s), and the lean follows at 0.15 per update (was 0.3). Worker: a
    held track is dropped only for a new id that appeared after it went
    missing (`drop_replaced`). Before, a neighbour's overlapping box dropped
    it, so a man beside another blinked out. A confirmed object stays until
    unseen for 12 s, and a re-detection with a shifted box keeps its id.
    Chair snap is cut to 0.08 m: at 0.25 m a sitter near the limit toggled
    0.25 m. Seated people are placed by shoulders, then hips, with ankles
    last, since ankles under a table put one man 0.4 m off. Over 60 s live, two
    seated people had 1 position step (6 cm), 0 posture flips and 1 presence
    change.
  - **Hand at chin while typing.** A wrist seen on a laptop, keyboard or mouse
    box rules out the face poses unless a phone is in that hand, and favours
    the table pose. An arm in the lap is not lifted onto the tabletop
    (`keepOutOfSolids` `lapSides`); that lift had put the hand beside the face.
  - **Facing and seat.** A seated person faces the laptop, keyboard or screen
    within 0.9 m of their shoulders, and the seat goes behind them, away from
    it. Someone placed from the top of the head is never moved.
  - **Camera view.** Shown letterboxed in the camera's aspect between the
    header and the status bar, with nothing over it. The side panels open from
    the Cameras/Details buttons. The status bar had hidden the man under the
    lens.
  - **Bottles.** Room scans run at 1920 px and BOTTLE needs 0.25 (still 3 of
    5 scans): 4–6 of 7 clear bottles stay, where 0–1 did before. The worker
    runs at ~1.8 fps.
  - **Colour without hips.** The shirt is read from the chest below the
    shoulders.
  - **Sitting down unseen.** A STANDING posture with the legs hidden lapses
    10 s after its last evidence. From this camera, sitting barely lowers the
    shoulders in the picture, so the shoulder-drop test could not see a man
    sit. Known trade-off: someone standing more than 10 s with the legs hidden
    at a table is then drawn "probably seated".
- **Fluctuation measured on the rendered twin (15 Oct, 16:45).** A 70 s
  capture of three seated people was replayed in the preview, and every
  figure's bones, facing, label text and objects were sampled 10× a second
  (the harness exposes the scene as `window.__twinScene`). Before → after,
  per minute:
  - label text changes: 26 → 4;
  - hand jumps over 4 cm in 0.1 s, typing man: ~23 → 0 apart from real pose
    changes;
  - facing drift: 2.3°/s → 0.02°/s;
  - body position drift: under 0.5 cm/s before and after.

  Changes:
  - **Labels.** Labels go through `StickyText` (5 s): "Seated", "probably
    seated" and the gesture phrases used to flip every 1–3 s.
  - **Arms and pose.** Bones ease at 3/s (was 12/s), so a new arm pose glides
    in over about a second. A new solved body is taken only when a joint moves
    more than 6 cm (`jointsMoved`). Stale pose evidence holds the last body
    for 30 s instead of dropping to the neutral pose and back.
  - **Facing.** It changes only for a turn of more than 15° and eases at
    2.5/s; the seat or laptop heading jitter had swung the hands.
  - **Hand grabs.** A hand that rests on a laptop or mouse keeps it out to
    0.4 m (`handsOnObjects` `locks`, objects carry their id).
  - **Objects.** They are held 6 s through a missed scan (`HoldMissing`).
  - **Worker.** A SEATED person never flips to CROUCHED. From above, the
    foreshortened shins read as a crouch three times a minute, moving the man
    0.3 m each time as the anchor changed.
- **Chairs: one per real chair, and people in them (15 Oct, 17:30).** On a
  live frame with 2 people and 4 real chairs, the twin drew 6 chairs: the
  unclaimed layout chairs stood where the camera saw empty floor, and layout
  chairs were rolled 1.3–1.4 m to each sitter while their own detected chair
  stood beside them. Bodies went through the duplicates, and rolled layout
  chairs kept their old rotation, so backrests crossed bodies. Changes:
  - **Backend.** A CHAIR is placed from its box bottom (nearest wheel) and its
    box top (backrest, 0.95 m) averaged, or from the backrest alone when the
    base reads outside the room. Method: `CHAIR_BASE_AND_BACKREST` or
    `CHAIR_BACKREST`. The far-end chair, hidden behind the table, read behind
    the far wall before.
  - **Seating.** A seated person sits on a seen chair within 0.7 m of their
    estimated pelvis; distance is measured from the seat point, not the
    leaning shoulders. The chair stays where seen, and the body leans from it
    (`leanDeg`).
  - **Steady chairs.** A seen chair moves only when its detection moves more
    than 0.15 m.
  - **Hidden layout chairs.** A layout chair the camera can see (base, seat or
    backrest top inside the picture), unconfirmed by a detection for 30 s, is
    hidden (`hiddenChairs`) and never rolled to anyone.
  - **Scene.** A sitter's chair is placed under them and turned with them
    every frame. Other chairs turn to their computed heading; layout chairs
    used to keep their layout rotation.

  Result on that frame: 4 chairs, where the 4 real ones are, with both men
  seated in theirs.
- **Root cause of the remaining fluctuation: chairs that came and went (15
  Oct, 18:00).** Two minutes of a room where nobody moved, run through the
  twin with every visible change logged: people's tracks were stable (3 ids
  for 123 s), but the chair set changed 10 times (new ids again and again; at
  most 3 of 4 chairs at once). Each chair change re-seated its sitter
  (seen chair ↔ inferred chair ↔ rolled chair), so a still person jumped
  0.3–0.5 m, turned 17–37° and swung 0°↔40° of lean every 10–20 s. Fixed at
  the source:
  - **Worker.** `StaticObjectMap` holds a long memory of furniture and desk
    objects, fed by both detectors. Objects are matched by box overlap or a
    near centre, confirmed after 3 sightings, and reported at the median of
    recent boxes with one stable id. They are kept unseen for 2 min (chairs,
    monitors), 60 s (laptops, bottles), 45 s (cups, mice) or 15 s (phones).
    For chairs, a box mostly inside another chair's box is the same chair.
  - **Twin.** A chair confirmed within 30 s still counts as seen for seating.
    A person's seat is sticky (`seatMemory`), and a new facing must hold 3 s.

  Result on a fresh 120 s capture: 4 chairs with stable ids, settled by 25 s.
  After that the twin changed once (a sitter moving with his chair, 0.27 m).
  Objects, before the map: about 20 appear/disappear events in 100 s.
- **Desk items (15 Oct, 18:20).** `deskItemPlacement` handles two cases.
  - **On open floor.** A desk item (laptop, keyboard, mouse, monitor, cup,
    bottle, phone, notebook) whose pixel lands on no tabletop is drawn only
    within 1 m of a person. Live, the floor-socket plate by the door was a
    remembered "laptop" (0.44) on the floor.
  - **Facing.** A laptop, screen or keyboard faces its user within 0.9 m,
    else the nearest drawn chair within 1.3 m. Live, the left laptop with
    nobody near faced the camera, then a man 1.07 m away; it now faces its
    chair.

  The left chair's position is within ~0.1–0.2 m of all three image
  estimates (base, backrest top, seat centre); the real chair stands angled
  to the table. An empty chair's rotation is not measured: it is drawn facing
  the table.
- **Solid bodies, tiny chairs, standing up (15 Oct, 18:30).**
  - **Solid bodies.** Estimated people were drawn see-through (opacity 0.8),
    so the chair behind a sitter showed as a dark slab inside his body. Bodies
    are solid now; the dashed ring and the ≈ label mark an estimate.
  - **Tiny chairs.** A 12 × 16 px "chair" (in the 640 × 360 calibration
    image) on the table edge was mapped beside a sitter's real chair.
    `StaticObjectMap.MIN_HEIGHT_PX` requires chairs to be at least 48 px tall
    in the worker's frame.
  - **Standing up.** From SEATED, STANDING now needs the shoulders up by
    0.2 torso or strong evidence (≥ 0.75 held 1 s). Live, a seated man whose
    guessed knees scored 0.41–0.55 was stood up, and his hips, taken at
    standing height, put him on the table. On his recording he now stays
    SEATED.
- **Laptop parts and a phone in both hands (15 Oct, 18:40).**
  - **Laptop parts.** In `StaticObjectMap`, a KEYBOARD, MONITOR or MOUSE whose
    box is at least 60% inside a larger LAPTOP box is that laptop's own keys,
    screen or touchpad, and is not reported. A part of a laptop matches the
    laptop (containment, like chairs). This addresses two "laptops" drawn
    stacked on the right.
  - **Phone in both hands.** On the owner's full-quality frame, a phone held
    in both hands at the chest scored 0.47 in the 480 px hand scan; it scores
    0.81 at 640 px, now the default (`--hand-imgsz 640`). `hand_object_scores`
    also counts a phone lying between both wrists (two-hand grip). Measured
    from either wrist alone it scored 0.44, under the 0.55 gate. On that frame
    PHONE_IN_HAND is now 0.77 for him and 0 for the other two.
- **Phones on the owner's frame (15 Oct, 18:45).** On the 18:28 full-quality
  frame:
  - **Phone in hand.** It was found at 0.47–0.60 by the 480 px hand scan and
    scored 0.44–0.61 for PHONE_IN_HAND, right around the 0.55 gate. With the
    640 px hand scan and the two-hand grip it is 0.81 and 0.86; the other two
    people score 0.
  - **Phones on the table.** Both are found, at 0.86 and 0.74. The phone that
    had lain on the papers was the one now in his hands.
  - **No double phone.** The 1920 px room scan also caught the in-hand phone
    (0.56). `drop_held_phones` removes a loose PHONE that overlaps a phone
    the hand scan says is held, so it is not drawn twice.
- **Using a laptop (15 Oct, 18:55).**
  - **Who uses it.** `assignDeskUsers` gives a laptop, monitor or keyboard to
    the nearest seated person within 1.1 m of their seat. The reach is taken
    from the pelvis, which sits behind the hands: live, the left man typing on
    his laptop was 0.98 m from its table spot, so the previous 0.9 m left the
    laptop unowned.
  - **Where it is drawn.** A used laptop is drawn on the table 0.5 m in front
    of its user (an arm's length) and faces them. Their hands rest on it, and
    their label reads "using laptop" (or "using screen").
  - **One bag.** In `StaticObjectMap`, HANDBAG and BACKPACK are one family
    (BAG). On his recording, the same bag was reported as both, overlapping.
- **Hallucinated laptops (15 Oct, 19:35).** The twin drew four laptops on a
  table that had two.
  - **A ghost at the far end.** A "laptop" at 0.44-0.55 confidence came back
    at the same empty spot, (557-635, 167-253) px, in four recordings. Real
    laptops ran 0.75-0.96. `StaticObjectMap.PUBLISH_MIN_CONF` holds a LAPTOP
    back until its running confidence reaches 0.6.
  - **One laptop as two halves.** With someone at it, a laptop is detected as
    its screen alone or its keys alone. `PART_SHARE` makes a box that shares
    30% with a laptop's box that laptop; chairs and tables still need 70%. A
    screen box directly over a keys box (x-overlap ≥ 60%, little gap) is one
    laptop. An open laptop's screen, read as a MONITOR 43% on the laptop's
    box, is folded into the laptop too.
  - **A second box in the same scan.** A detection whose only match is an
    object already matched this scan (two models, or a part and the whole)
    is that object again, not a new one.
  - **Twin.** `duplicateDeskItems` draws laptops, screens and keyboards
    within 0.4 m of each other once, keeping the most confident (a laptop
    over its own screen).

  On a fresh recording the worker published exactly the three real laptops
  (one of them closed). The twin draws all of them open: whether a laptop is
  open or closed is not detected.
- **Laptop position, open or closed, and a dev view (15 Oct, 20:00).**
  - **Position.** A laptop was drawn centred on its box's bottom pixel, which
    is its front edge, so it sat ~0.1 m toward the camera; the left one looked
    misplaced. `laptopOnSurface` (twinCameraMatch.mjs) casts the box top onto
    the same tabletop as well. The laptop's middle is half its depth behind
    the front edge.
  - **Open or closed.** The box top, cast onto the tabletop, lands far behind
    an open laptop's front edge, because its screen stands up. Live: 0.97 m
    and 0.98 m for the two open ones, 0.44 m for the closed one. Closed means
    under 0.5 m + 0.05 × distance from the camera. A closed laptop is drawn
    with its lid shut and is never "used".
  - **Dev view.** In Camera view, administrators (and the preview harness)
    get a bug button that shows raw model output.
    - **Side by side** (the default) puts the live camera with its boxes
      beside the twin's camera view. **Live** draws the boxes on the live
      camera. **Over twin** draws them over the simulated view.
    - The live picture comes from `GET /api/cctv/twin/stream`
      (`relayStream`). The backend relays the CCTV app's MJPEG so `CCTV_KEY`
      stays on the server.
      - Limits: administrators only, at most 5 fps, 10 minutes per
        connection (the viewer reconnects), and stopped when the viewer
        leaves.
      - Nothing is stored. This is billed egress while the dev view is open.
      - When no stream opens (not an administrator, or CCTV not configured),
        the view falls back to the mapping still every 2.5 s.
      - The browser splits the stream with `JpegSplitter`
        (twin/twinMjpeg.mjs), because an `<img src>` cannot carry the Bearer
        token.
      - The header shows the stream fps and how old the newest boxes are.
    - **People:** the detector box, the worker's own posture call and
      confidence, tracking confidence, anchor, the twin's posture, body points
      (wrists in red), and every hand score, including those under the
      evidence floor.
    - **Objects:** type, confidence, scans confirmed, and what the twin did
      with each one: hidden as a duplicate, open or closed, or which person
      uses it.
    - The worker now sends each person's box (`imageBoxPx`). The backend
      passes it on in `visual.detector`, numbers only.
- **Left chair, turned-away sitter, laptop use, phone, bag (15 Oct, 20:35).**
  Each finding comes from 20-40 s of real frames next to the twin's camera
  view.
  - **Left chair (root cause).** The first rough position of a man rolled his
    unseen chair 0.3 m. Each later update he "sat" on it then stamped it as
    seen by the camera, and a camera-seen chair keeps its sitter within
    0.7 m. So the first guess was locked in for good.
    - Only a real detection now marks a chair seen.
    - A layout chair with a person within 0.7 m is no longer hidden for
      being unseen: the person's body is what hides it from the camera.
      Before, it was hidden, and a chair was invented 0.3 m nearer the table.
  - **Turned away.** A seated person faced their nearest laptop or the
    table, whatever the pose said. Strong pose evidence (≥ 0.85, held 6 s)
    that is more than 60° off now wins, and the chair turns with them. Live:
    a man faced the door with his phone (yaw -135 at 0.93).
  - **Crouched in a chair.** Seen from behind, a seated man read CROUCHED
    0.75-0.83.
    - Worker: `seated_on_chair` gives the crouch score to SEATED when the
      hips are inside a detected chair's box.
    - Twin: CROUCHED within 0.6 m of a chair is drawn "probably seated" (his
      own body can hide the chair from the detector).
    - CROUCHED places by shoulders before ankles: from behind, the ankles are
      guesses under the chair, 0.3-0.5 m off.
  - **Laptop use.** A laptop is used only with a wrist within half its box's
    diagonal (`handsOnBox`), seen twice in a row and held 5 s. Typing: 0-0.40;
    a man reading his phone beside the laptop: 0.64 or more. With the wrists
    unseen, distance decides, as before.
  - **Phone in hand.** It was found in only 4 of 12 frames, and the worker
    needed 3 of 5 scans every 2 s, so it never confirmed. Now scans run every
    1 s and 2 of 6 confirm it (kept 6 s). On those frames PHONE_IN_HAND
    scored 0.78-0.96.
  - **Bag.** A backpack cut off by the frame bottom was placed on the floor
    beyond the table. `bagOnSurface` places it from its box middle, lying
    along its long side. Its colour comes from the worker (`object_colour`,
    hex only): live `#527696`, the blue bag. Any object cut off at the
    bottom edge is placed from its box middle.
  - **Still open.**
    - An empty chair's rotation is not measured; it is drawn facing the
      table. Live, the left chair stood ~45° off.
    - The far-end chair's base is hidden by the table, so its box bottom is
      the table edge: drawn ~0.3 m nearer the camera.
- **Physics and real-world rules, audited (15 Oct, 21:00).** Live: a laptop
  brought in front of its user floated past the table edge, and both hands
  met inside it, through the screen.
  - **Support** (`settleOnSurfaces`, twinGeometry.mjs). Every desk item
    rests on its tabletop. One the twin moved itself stays wholly on the
    table, at the nearest spot clear of everything else there. Ones the
    camera placed keep at least their middle on the table and are eased
    apart, half each, when they overlap (live: two bottles drawn 2 cm
    apart). Items on the floor are separated too.
  - **Hands** (`deckSlots`, twinSkeleton.mjs). On a laptop or keyboard the
    wrists rest on its palm rest, 8 cm either side of the middle, in front
    of the keys and clear of the hinge. They are no longer both drawn at its
    middle. Closed laptops are not typed on. After the hands are placed, the
    furniture check runs again, so an elbow reaching for the keys rests on
    the table top instead of entering it.
  - **Walls** (`separate`, twinPhysics.mjs). A chair pushed by a passer-by
    stays inside its room (live: 0.14 m from the wall, half inside it).
    Chairs are kept 0.5 m apart, their real width.
  - **Sitting down.** A posture change with the same points re-sent rebuilds
    the body, and the joint filters restart. A sit-down plays over about a
    second instead of several seconds half standing in the chair.
  - **Laptop use tolerance** is 0.42 box diagonals: typing measured
    0.00–0.41 over three recordings, and a man reading his phone came no
    nearer than 0.45.
  - **The rules as code** (`twinAudit.mjs`, `window.__twinAudit()` in the
    preview harness). Each check lists what the scene breaks in what it
    actually draws:
    - gravity: nothing hanging, floating past an edge or overhanging;
    - solidity: nothing inside anything else; no hand, elbow, torso or knee
      inside the table; no hand inside a laptop or through its screen;
    - bodies: feet on the floor, a seated pelvis at seat height;
    - rooms: no chair or person in a wall; chairs not driven into the table
      or into each other; nobody inside a chair.
  - **Results.** On three recordings (one, two and three people) the list
    went to empty. The one exception is a seated person's first second on
    screen, while the body is still forming.
- **Human movement between keyframes (15 Oct, 21:45).** A figure was set
  straight onto the keyframe curve.
  - **What went wrong.** When a late position pulled the curve back, it
    jumped. It faced its seat or pose direction while walking, and its legs
    snapped into and out of the walk at one speed. Measured offline at 60 fps
    on recordings with walks: up to 38 m/s, 0.63 m in one frame, 2,277 m/s²,
    440°/s turns, and up to 71 frames walking sideways.
  - **Now, in twinMotion.mjs (all used by twinAvatar.js):**
    - `HumanMover` gives each figure a body with momentum that chases the
      curve. Speed is capped at 1.4 m/s (2.0 m/s when catching up, 0.5 m/s
      rolling a chair while seated). Acceleration is capped at 2.5 m/s². It
      brakes at 80% of that so it arrives without stopping dead, and it only
      shuffles in a direction it does not yet face. Only a jump of more than
      4 m (re-association) is placed.
    - `nextYaw`: a travelling figure faces where it goes (a short step back
      from a table is taken backwards). Turns are eased and capped at
      ~200°/s standing and ~120°/s turning a chair.
    - `nextGait`: the walk cycle eases in above 0.15 m/s and out below
      0.06 m/s. Seated people never walk; their chair rolls. On stopping, the
      feet finish their step and come together.
    - `gaitJoints` swings hanging arms against the legs; an arm doing
      something (phone, face) keeps its pose. `blendJoints` blends the body
      into and out of the walk.
    - `springOffset`: physics pushes on people and chairs move with mass,
      instead of an instant ease.
    - Scripted walks to a door speed up and slow down, and their corners are
      walked round.
  - **Results.** Same recordings, same code: ≤ 1.4 m/s, ≤ 2 cm per frame,
    ≤ 2.5 m/s², ≤ 200°/s. What remains is brief turning while walking
    (≤ 15 frames) and feet settling after a stop (≤ ~0.7 s).
- **Checked against recorded CCTV: one person, one figure (15 Oct, 21:55).**
  The 16:11 minute (live_rec4) was replayed beside NVR playback of the same
  minute (CP Plus `/cam/playback`, pulled by a scratch script using the
  backend's NVR config; frames kept in the scratchpad and deleted after use).
  The NVR clock runs ~51.8 s behind this machine's. In the recording, a man
  stands up from his laptop and walks round the table's near end and up the
  left side to the door. Four fixes followed:
  - **Handoff** (`TrackHandoff`, twinSteady.mjs). The tracker lost him as he
    rose. The worker held his track for 4–6 s, frozen at the laptop with
    identical points, and found him again 2 m away under a new id. The twin
    had drawn a seated ghost plus a stranger. Now a new id that appears
    within walking distance of a frozen or just-vanished one takes over its
    figure and label, and the frozen copy is dropped. A track counts as
    frozen only while the camera's feed is alive (another of its tracks
    changed since), so a stalled feed hands nobody off.
  - **Not held in a chair on the move.** "Seated moments ago" now applies
    only where the person sat (within 0.6 m). Someone moving more than 0.6 m
    in the last few seconds (`moving`, from SteadyPeople) is never assumed
    seated. The handed-off man had been rolled 2 m across the room still
    seated.
  - **Turn, then walk, without a deadlock.** A figure turns toward where it
    must go (`HumanMover` now returns `toward`), not the way it is already
    drifting. Held to a slow shuffle until it faced its way, it never got a
    direction to turn to, and stood at its seat.
  - **Upright walking and walls.** `uprightTorso` straightens a walking body
    to ≤ ~10° of lean (he walked out bent 45° over the table). People keep
    0.2 m off walls except at a door (he was drawn on the glass wall).
  - **Result.** One figure gets up, walks round the table's near end and up
    the left side to the far end, about 1–2 s behind the camera.
  - **Still to do.**
    - His shirt colour flips briefly at the handoff: the new track's first
      colour reading is wrong.
    - The worker's 6 s hold (`--track-hold`) is most of the remaining delay
      before he is found again. Shortening it is a trade-off against seated
      people blinking out behind the table.
- **Steady clothing colours (15 Oct, 22:05).** `StickyColours`
  (twinSteady.mjs), used by twinAvatar.js. A small drift in colour (≤ 60 RGB)
  is followed at once. A clearly different colour is worn only once it has
  held for 3 s. This fixes the green shirt that flashed purple at the tracker
  handoff. A real change, such as a jacket coming off, still shows after 3 s.
  The worker's track hold went from 6 s to 3 s (owner's choice): a person who
  gets up is let go of 3 s sooner, and the twin's 3 s grace still bridges a
  sitter briefly hidden behind the table.
- **Walks go round tables; recorded side by side at 30 fps (15 Oct, 22:25).**
  Owner: the walk went through the table and skipped.
  - **Measured on every rendered frame.** The twin's own motion had no
    skips: at most 2.9 cm per frame, no frame gap over 23 ms. The skips were
    the old capture method, timed screenshots of a busy page replayed at a
    fixed rate. The table problem was real: 51 frames inside it, walking a
    straight line from the seat to the far side, and the left wall was used
    as a path.
  - **Routes** (`makeRouter`, `carrotOnPath`, twinMotion.mjs, built by
    TwinScene). A walking figure follows an A* route round solid furniture
    (0.3 m clearance), with goals moved 0.22 m off the walls except at a
    door. It steers for a point 0.6 m ahead on the route, giving smooth
    curves at walking pace, and slows only for the end. The route is
    re-planned when the goal moves or every 0.5 s. When the route left is
    over 1 m it hurries, up to 2 m/s (`behindM`). Same recording afterwards:
    0 frames in the table, 0 on a wall.
  - **Recording.** The preview runs in a headless Chrome (playwright-core
    with the installed Chrome and a fresh profile, ~60 fps whatever the app
    window does). The canvas is recorded frame by frame with MediaRecorder
    (`requestFrame` after each render) and stacked with the NVR playback of
    the same moment at 30 fps. Playback starts ~1 s before the requested
    second; the NVR clock is ~51.8 s behind.
  - **What is left.** The twin trails the real walker by ~1.5–2 s. While he
    walks along the bottom edge of the picture the camera barely sees him,
    and nothing can move the figure until the tracker finds him again.
- **A human walk cycle (16 Oct).** The owner said the twin "doesn't look like
  he's walking". The old cycle was a pendulum: the same stride at every speed
  (feet skating), stiff legs, and arms left in the pose the camera last saw
  (stretched out ahead).
  - **`gaitJoints`** (twinSkeleton.mjs) now places the feet and solves the
    knees by two-bone IK:
    - stance: the foot is planted and moves back under the body at exactly
      its speed, so it doesn't slide;
    - swing: the foot is lifted 9–12 cm and carried forward, eased, with the
      knee flexing 64–72°;
    - pelvis: carried by the planted leg, which is nearly straight at heel
      strike and flexed ~18° as the body passes over, giving a 3.5 cm bob at
      1.2 m/s; it sways 2 cm over the planted foot;
    - torso: leans forward 5–11° with speed;
    - arms: swing against the legs, elbows bending more on the forward
      swing. Only a phone at the ear (`keepArms`) keeps its pose.
  - **Speed.** `stepLengthFor(speed)` gives about 0.49 m (≈75 steps/min) at
    0.6 m/s, 0.68 m (≈105/min) at 1.2 m/s, and 0.8 m brisk. `nextGait`
    advances the phase by distance over that step length, so cadence follows
    speed. Catch-up is a brisk 1.7 m/s, never a run. Measured: 0.0 cm foot
    slip at 0.6, 1.2 and 1.7 m/s.
  - **Video.** `tmp/cctv-review/cctv_vs_twin_walk_v2.mp4` (git-ignored):
    NVR playback against a headless recording of the twin (1280×720 layout
    at 2× pixel density; a 1920×1080 layout framed the view differently),
    full view plus a close-up of the left of the room.
- **The conference room's door; leaving properly (16 Oct).** A man who had
  walked out was still drawn standing inside the door corner, turned to the
  camera; the room had no door in its layout.
  - **Door, in the live layout.** The owner asked for it. Layout v12 was
    saved through `saveFactoryTwinLayout`, with v11 backed up to
    `tmp/cctv-review/backups/factory-twin-config-v11.json`. The new item:
    `door-1`, "Glass door", on the far wall (z = 0), centre x 0.42 m, 0.85 m
    wide, APPROXIMATE. Measured on NVR playback of 15 Oct 16:11:16–19: a man
    walks out through the opening at the far wall's left end.
  - **The door opens.** The leaf hangs on a hinge, drawn as frosted glass
    when labelled glass. It swings open for anyone within 1.2 m and closes
    behind them, so nobody walks through a shut door.
  - **Leaving** (TwinScene):
    - A walker the feed holds at their last position near a wall (≤ 1.2 m,
      or already outside) has gone. They leave after 0.2 s instead of the
      3 s hold plus 1.2 s grace, and walk to the door even with posture
      unknown (seen only from the waist up).
    - A held copy never revives someone leaving: once outside, it had
      cancelled the exit and walked him back in.
    - Exit routes use the room the person is in; it used to be the first
      room of 23.
    - People never pass through walls. Without a door, they fade where they
      are.
    - Someone appearing by a door walks in through it only when standing,
      and not in the first 5 s, so a sitter by the door isn't drawn walking
      in.
  - **No turning round:**
    - For a target under 0.6 m away and more than 60° off, a person
      shuffles; they don't turn round (a 10 cm settle had turned him 125°).
    - For 3 s after walking, a standing person keeps facing the way they
      walked rather than the camera's facing estimate, which pointed him at
      the camera.
    - Scripted walks steer for a point 0.5 m ahead of their own progress on
      the path; they had circled the doorway's sharp turn, spinning ~300°.
  - **Chairs:**
    - Routes walk round chairs as they stand now.
    - A chair someone stands up from rolls 0.35 m back, never into a wall.
      Against a wall, the person steps clear instead (`separate`).
    - Chairs make way for walkers briskly.
  - **Checked.** Headless audit over the replay: from the stand-up to the
    end of the walk-out, only the first second of standing up is flagged.
    Video: `tmp/cctv-review/cctv_vs_twin_walk_v3.mp4`.
- **Rapier as the twin's collision layer (16 Oct).** The owner asked for it.
  It uses `@dimforge/rapier3d-compat` 0.19.3, pinned exactly in grav-cms
  package.json (Apache-2.0, WASM).
  - **What it makes solid** (`twin/twinRapier.mjs`, `RoomPhysics`):
    - walls: boxes along each room's walls, with real gaps at doors and at
      open joins between rooms;
    - tables and other solid furniture: boxes from the floor to the top;
    - walkers: capsules (r 0.22 m) moved by Rapier's character controller,
      which slides them along anything solid and pushes chairs;
    - sitters: placed on their seat. They block walkers but don't collide
      with their own table or chair;
    - chairs: rolling bodies (8 kg, damped, upright) that walkers push, which
      stop at walls, tables and each other, and drift back to their layout
      or camera position at ≤ 0.4 m/s once the way is clear. A chair someone
      sits on goes with them.
  - **What stays ours.** Our motion still decides where people want to be:
    keyframes, `HumanMover`, routes and the walk cycle. Rapier decides where
    they can be, and the result is fed back into the mover.
  - **Loading.** TwinScene loads Rapier with a dynamic import, so the page
    downloads it after its first render. Until the WASM is ready, the
    hand-written `separate()` stands in.
  - **Routing.** Chairs became soft in route planning: passable at five
    times the cost. Treated as hard and padded, they sealed both ends of the
    table, no route was found, the straight-line fallback ran into the table,
    and Rapier (rightly) held the walker there.
  - **Checked.**
    - twinRapier.test.mjs runs on the real engine: the table stops a walker,
      a wall holds, the doorway lets them out, a pushed chair stays out of
      the wall and rolls home, and a sitter's chair stays with them.
    - The headless audit over the replay flags only the instant of standing
      up (1 of 119 samples). Before, the stand-up flagged for over a second,
      along with chairs in walls and walkers in chairs.
    - Video: `tmp/cctv-review/cctv_vs_twin_walk_v4_rapier.mp4`. The NVR
      playback port timed out, so its real panels are reused from v3, the
      same window.
  - **Not checked.** A production `next build` with the WASM package.

- **Phone in hand, measured in the person's own hand lengths (16 Oct).**
  - **Two misses, one root cause.**
    - A man reading a phone held up in his fingers showed as "using laptop".
    - A man leaning over the table with a phone in both hands flickered
      between 0 and 0.84.
    - The detector found both phones (0.35–0.93), so it was not at fault.
      `hand_object_scores` measured everything in torso lengths
      (shoulder-mid to hip-mid), and treated the hand as a point at the
      wrist.
    - A seated or leaning body shows a foreshortened torso: 57–84 px beside
      120 px shoulders. When the hips drop below keypoint confidence there is
      no torso at all, and the score was 0.
    - A phone gripped in the fingers lies a hand length beyond the wrist
      point, so it was "too far".
  - **The rule now.**
    - `hand_length_px` estimates the hand from the torso (×0.38) and from the
      shoulder width (×0.52), and takes the larger. A camera only ever
      shortens a body part, so the longer estimate is the least
      foreshortened. With no hips, the shoulders alone still give it.
    - The hand runs one hand length from the wrist along the forearm (elbow →
      wrist). A phone touching that line within half a palm (0.2 hand) is
      held.
    - Where the elbow is not trustworthy, only a tight circle round the wrist
      counts: full credit within 0.3 hand, none beyond 0.6. Arms are the
      least reliable keypoints; live, an elbow was placed above its own
      wrist.
    - The two hands' evidence combines (1 − Π(1 − hᵢ·wristᵢ)), which replaces
      the separate "between the wrists" rule.
    - A detection counts fully from 0.5 confidence (was 0.6).
    - Nothing depends on this camera's angle. The first attempt that day
      ("the phone must sit above the wrist in the picture") did, and was
      replaced.
  - **Live replays.**
    - The leaning man: 0.93–0.96 steady (was 0 / 0.84 / 0 / 0.46).
    - The man reading his phone: 0.86–0.96 (was 0.00–0.24).
    - Everyone else in both scenes: 0.00, including a typist with a phone
      lying beside his laptop.
    - `cctv_twin_pose_test` 92/92. New cases: gripped beyond the wrist; hips
      hidden; body leaning toward the camera; phone lying beside a typing
      hand; phone far from both hands at 0.95.
  - **Not solved: a phone the detector cannot see.** Held low against the
    chest and seen edge-on from behind, a phone is about 20 × 10 px at
    1280 × 720.
    - The person-crop scan, a tighter crop on the hands, and YOLO-World all
      scored it under 0.25 or found nothing.
    - That is a pixel limit, not a rule. The fix is more resolution for the
      hand crops: the camera's main stream is capped at 1280 × 720 by the
      CCTV app, and the Original snapshot returned 403. A hand-object
      contact model would be the other route.
  - Needs a worker restart.
