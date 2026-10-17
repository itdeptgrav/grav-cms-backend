"""Pure posture, orientation and floor-anchor geometry for the CCTV twin worker.

Everything here works on COCO-17 keypoints in image pixels (x right, y down)
and their per-keypoint confidences. There is deliberately no torch/ultralytics
import: the worker runs the pose model, this module only interprets it, so it
can be unit-tested with synthetic skeletons.

Contract: docs/decisions/cctv-twin-posture-layout-contract.md. Posture comes
from evidence or is UNKNOWN; orientation is camera-relative (0 = facing the
camera, +90 = facing image-right, +/-180 = facing away).
"""

import math

NOSE, LEFT_EYE, RIGHT_EYE, LEFT_EAR, RIGHT_EAR = 0, 1, 2, 3, 4
LEFT_SHOULDER, RIGHT_SHOULDER = 5, 6
LEFT_HIP, RIGHT_HIP = 11, 12
LEFT_KNEE, RIGHT_KNEE = 13, 14
LEFT_ANKLE, RIGHT_ANKLE = 15, 16

POSTURES = ("STANDING", "SEATED", "CROUCHED")
KEYPOINT_CONFIDENCE = 0.4
ANKLE_CONFIDENCE = 0.4
# A knee behind a table edge is often guessed at 0.4-0.5; posture needs a knee
# the model is surer of (live: guessed knees read a man standing at the table
# as SEATED 0.9, which put him at the far wall).
KNEE_POSTURE_CONFIDENCE = 0.5
FACE_CONFIDENCE = 0.5
# Floor point below the hip midpoint, in torso lengths, by posture.
HIP_TO_FLOOR_TORSOS = {"SEATED": 0.85, "STANDING": 1.85, "CROUCHED": 0.6}
# Image shoulder width of a person squarely facing the camera, in torso
# lengths (shoulder midpoint to hip midpoint). COCO shoulder keypoints sit
# well inside the acromion: yolov8n-pose measured 0.51-0.54 on frontal
# people in the Ultralytics sample image, so 0.55 rather than the
# anthropometric ~0.75. Re-measure on site footage when it is available.
FRONTAL_SHOULDER_TO_TORSO = 0.55
_BODY_POINTS = (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP,
                LEFT_KNEE, RIGHT_KNEE, LEFT_ANKLE, RIGHT_ANKLE)


def _clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def _ramp(value, start, end):
    """0 at `start`, 1 at `end`, linear between (either direction)."""
    if end == start:
        return 1.0 if value >= end else 0.0
    return _clamp((value - start) / (end - start))


def _conf(confs, index):
    try:
        value = float(confs[index])
    except (TypeError, IndexError, ValueError):
        return 0.0
    return value if math.isfinite(value) else 0.0


def _point(keypoints, index):
    x, y = keypoints[index][0], keypoints[index][1]
    return float(x), float(y)


def _visible(confs, indices, threshold=KEYPOINT_CONFIDENCE):
    return [i for i in indices if _conf(confs, i) >= threshold]


def _mean_point(keypoints, indices):
    if not indices:
        return None
    xs = [_point(keypoints, i)[0] for i in indices]
    ys = [_point(keypoints, i)[1] for i in indices]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _torso(keypoints, confs):
    """Return (shoulder_mid, hip_mid, torso_length) or None."""
    shoulders = _visible(confs, (LEFT_SHOULDER, RIGHT_SHOULDER))
    hips = _visible(confs, (LEFT_HIP, RIGHT_HIP))
    if not shoulders or not hips:
        return None
    shoulder_mid = _mean_point(keypoints, shoulders)
    hip_mid = _mean_point(keypoints, hips)
    length = math.hypot(shoulder_mid[0] - hip_mid[0], shoulder_mid[1] - hip_mid[1])
    if length < 1e-3:
        return None
    return shoulder_mid, hip_mid, length


def _shoulder_height(keypoints, confs):
    """(shoulder-midpoint y, scale) where scale is the torso length if the
    hips are visible, else 1.8 shoulder widths. None without both shoulders."""
    if len(_visible(confs, (LEFT_SHOULDER, RIGHT_SHOULDER))) < 2:
        return None
    mid = _mean_point(keypoints, (LEFT_SHOULDER, RIGHT_SHOULDER))
    torso = _torso(keypoints, confs)
    if torso is not None:
        return mid[1], torso[2]
    left = _point(keypoints, LEFT_SHOULDER); right = _point(keypoints, RIGHT_SHOULDER)
    width = math.hypot(left[0] - right[0], left[1] - right[1])
    return (mid[1], 1.8 * width) if width > 1e-3 else None


def _angle(a, b, c):
    """Interior angle at b, degrees."""
    v1 = (a[0] - b[0], a[1] - b[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 < 1e-6 or n2 < 1e-6:
        return None
    cos = _clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2), -1.0, 1.0)
    return math.degrees(math.acos(cos))


def _empty_scores():
    return {name: 0.0 for name in POSTURES}


def classify_posture(keypoints, confs):
    """Score STANDING / SEATED / CROUCHED from COCO-17 geometry.

    Returns (scores, visibility). All-zero scores mean the legs are not
    visible enough to say anything: the posture is UNKNOWN, not a guess.

    The primary cue is the thigh's vertical drop relative to torso length,
    (knee.y - hip.y) / T: about 0.8 standing, near 0 for a seated side view,
    and still small for a frontal seated view where the thigh points at the
    camera and foreshortens. The hip-knee-ankle angle is secondary because a
    frontal seated shin and foreshortened thigh look almost straight in 2D.
    """
    visibility = sum(_clamp(_conf(confs, i)) for i in _BODY_POINTS) / len(_BODY_POINTS)
    scores = _empty_scores()
    torso = _torso(keypoints, confs)
    if torso is None:
        return scores, visibility
    _, hip_mid, torso_length = torso

    drops, angles, ankle_drops, used = [], [], [], []
    for hip, knee, ankle in ((LEFT_HIP, LEFT_KNEE, LEFT_ANKLE), (RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE)):
        hip_ok = _conf(confs, hip) >= KEYPOINT_CONFIDENCE
        knee_ok = _conf(confs, knee) >= KNEE_POSTURE_CONFIDENCE
        ankle_ok = _conf(confs, ankle) >= ANKLE_CONFIDENCE
        hip_point = _point(keypoints, hip) if hip_ok else hip_mid
        if knee_ok:
            knee_point = _point(keypoints, knee)
            drops.append((knee_point[1] - hip_point[1]) / torso_length)
            used.extend([hip, knee] if hip_ok else [knee])
            if ankle_ok:
                angle = _angle(hip_point, knee_point, _point(keypoints, ankle))
                if angle is not None:
                    angles.append(angle)
        if ankle_ok:
            ankle_drops.append((_point(keypoints, ankle)[1] - hip_point[1]) / torso_length)
            used.append(ankle)
    if not drops:
        return scores, visibility

    drop = sum(drops) / len(drops)
    standing = _ramp(drop, 0.45, 0.65)
    seated = 1.0 - standing
    if angles:
        angle = sum(angles) / len(angles)
        angle_standing = _ramp(angle, 120.0, 150.0)
        if angle <= 60.0:
            angle_seated = _ramp(angle, 40.0, 60.0)
        else:
            angle_seated = 1.0 - _ramp(angle, 120.0, 150.0)
        standing = 0.65 * standing + 0.35 * angle_standing
        seated = 0.65 * seated + 0.35 * angle_seated

    crouched = 0.0
    if ankle_drops and angles:
        ankle_drop = min(ankle_drops)
        bent = 1.0 - _ramp(sum(angles) / len(angles), 110.0, 130.0)
        # A true crouch puts the hips almost at heel height. From a high CCTV
        # mount a seated person's shins foreshorten to ~0.5 T, so anything
        # looser than ~0.3 T mislabels people sitting at a table.
        crouched = (1.0 - _ramp(ankle_drop, 0.2, 0.35)) * bent
        standing *= 1.0 - crouched
        seated *= 1.0 - crouched

    # Weak keypoints give weak evidence; the knee most of all (it decides).
    quality = _clamp((sum(_conf(confs, i) for i in used) / len(used)) / 0.6) if used else 0.0
    knee_conf = max(_conf(confs, LEFT_KNEE), _conf(confs, RIGHT_KNEE))
    quality *= _clamp(knee_conf / 0.8)
    scores = {
        "STANDING": round(_clamp(standing) * quality, 4),
        "SEATED": round(_clamp(seated) * quality, 4),
        "CROUCHED": round(_clamp(crouched) * quality, 4),
    }
    return scores, visibility


def estimate_orientation(keypoints, confs):
    """Camera-relative body yaw: (relative_yaw_deg, confidence).

    0 = facing the camera, +90 = facing image-right, +/-180 = facing away.
    Returns (None, 0.0) when the shoulders or torso are not visible.

    COCO left_shoulder is the SUBJECT's left: facing the camera it appears at
    the larger image x. Shoulder width / torso length gives |cos yaw|; the
    sign of the shoulder vector and visible face keypoints say front or back;
    the face's horizontal offset from the shoulder midpoint gives the side.
    """
    if _conf(confs, LEFT_SHOULDER) < KEYPOINT_CONFIDENCE or _conf(confs, RIGHT_SHOULDER) < KEYPOINT_CONFIDENCE:
        return None, 0.0
    torso = _torso(keypoints, confs)
    if torso is None:
        return None, 0.0
    shoulder_mid, _, torso_length = torso
    left = _point(keypoints, LEFT_SHOULDER)
    right = _point(keypoints, RIGHT_SHOULDER)
    dx = left[0] - right[0]
    cos_abs = _clamp(abs(dx) / (FRONTAL_SHOULDER_TO_TORSO * torso_length))
    theta = math.degrees(math.acos(cos_abs))  # 0 frontal/back, 90 profile

    face = _visible(confs, (NOSE, LEFT_EYE, RIGHT_EYE), FACE_CONFIDENCE)
    face_front = _conf(confs, NOSE) >= FACE_CONFIDENCE and len(face) >= 2
    if cos_abs > 0.3:
        front = dx > 0
        certainty = 1.0 if face_front == front else 0.5
    else:
        # Near profile the shoulder order is unreliable; a visible face is the
        # only front/back cue, and the yaw is close to +/-90 either way.
        front = face_front
        certainty = 0.8 if face else 0.6
    magnitude = theta if front else 180.0 - theta

    side_points = _visible(confs, (NOSE, LEFT_EYE, RIGHT_EYE, LEFT_EAR, RIGHT_EAR), KEYPOINT_CONFIDENCE)
    side = 0.0
    if side_points:
        face_x = _mean_point(keypoints, side_points)[0]
        side = face_x - shoulder_mid[0]
    if abs(side) < 0.02 * torso_length:
        # No side cue: the magnitude is known, its direction is not. This is
        # harmless when nearly frontal/back and serious near profile.
        sign = 1.0
        certainty *= cos_abs
    else:
        sign = 1.0 if side > 0 else -1.0
    yaw = sign * magnitude
    if yaw <= -180.0:
        yaw += 360.0
    if yaw > 180.0:
        yaw -= 360.0
    confidence = min(_conf(confs, LEFT_SHOULDER), _conf(confs, RIGHT_SHOULDER)) * certainty
    return round(yaw, 1), round(_clamp(confidence), 3)


# Nose height above the floor by posture (adults), for POSE_HEAD_ESTIMATE; the
# backend uses the same values when none is sent. Shoulders sit ~0.25 m lower.
def object_colour(frame, box):
    """The colour of an object (median of the middle half of its box), as
    #rrggbb, so the twin can draw a bag in its own colour (live: a blue
    backpack drawn grey). A colour only; never an image."""
    if frame is None:
        return None
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    cx1, cx2 = int(max(0, x1 + (x2 - x1) * 0.25)), int(min(w, x2 - (x2 - x1) * 0.25))
    cy1, cy2 = int(max(0, y1 + (y2 - y1) * 0.25)), int(min(h, y2 - (y2 - y1) * 0.25))
    if cx2 - cx1 < 2 or cy2 - cy1 < 2:
        return None
    patch = frame[cy1:cy2, cx1:cx2].reshape(-1, 3)
    b, g, r = (int(sorted(patch[:, i].tolist())[len(patch) // 2]) for i in range(3))
    return f"#{r:02x}{g:02x}{b:02x}"


def seated_on_chair(scores, keypoints, confs, chair_boxes):
    """A person whose hips are inside a detected chair's box is sitting on it,
    not crouching: the crouch score is given to SEATED. Live, a man seated
    with his back to the camera, shins pointing away, read CROUCHED 0.75-0.83
    for half a minute while his chair was detected around him."""
    if not chair_boxes or scores.get("CROUCHED", 0.0) <= 0.0:
        return scores
    torso = _torso(keypoints, confs)
    if torso is None:
        return scores
    hx, hy = torso[1]
    if not any(b[0] <= hx <= b[2] and b[1] <= hy <= b[3] for b in chair_boxes):
        return scores
    out = dict(scores)
    out["SEATED"] = round(min(1.0, out.get("SEATED", 0.0) + out["CROUCHED"]), 4)
    out["CROUCHED"] = 0.0
    return out


HEAD_HEIGHT_M = {"STANDING": 1.6, "SEATED": 1.2, "CROUCHED": 0.9, "UNKNOWN": 1.4}
# Hip-joint height above the floor by posture, for POSE_HIP_HEIGHT. Legs hidden
# with hips seen is nearly always someone seated at a table, so UNKNOWN sits.
HIP_HEIGHT_M = {"STANDING": 0.95, "SEATED": 0.5, "CROUCHED": 0.45, "UNKNOWN": 0.5}
# Shoulder height by posture, for POSE_SHOULDER_HEIGHT. Measured on the
# Conference Room capture: shoulders at 1.0 m agree with the hip point at
# 0.5 m to a 6 cm median, and are seen far more often behind a table.
SHOULDER_HEIGHT_M = {"STANDING": 1.45, "SEATED": 1.0, "CROUCHED": 0.85, "UNKNOWN": 1.0}
# Crown (top of the head) height by posture, for BOX_TOP_HEIGHT.
CROWN_HEIGHT_M = {"STANDING": 1.75, "SEATED": 1.3, "CROUCHED": 1.0, "UNKNOWN": 1.3}
SHOULDERS_BELOW_HEAD_M = 0.25
# A box whose bottom is this close to the frame's bottom edge is cut off by it.
CUT_OFF_PX = 3.0


def head_point(keypoints, confs):
    """(pixel, metres below the nose) of the best visible head point, or None:
    the nose, else the mean of visible eyes/ears, else the shoulder midpoint."""
    if keypoints is None or confs is None:
        return None
    if _conf(confs, NOSE) >= KEYPOINT_CONFIDENCE:
        return _point(keypoints, NOSE), 0.0
    face = _visible(confs, (LEFT_EYE, RIGHT_EYE, LEFT_EAR, RIGHT_EAR), KEYPOINT_CONFIDENCE)
    if face:
        return _mean_point(keypoints, face), 0.0
    shoulders = _visible(confs, (LEFT_SHOULDER, RIGHT_SHOULDER), KEYPOINT_CONFIDENCE)
    if len(shoulders) == 2:
        return _mean_point(keypoints, shoulders), SHOULDERS_BELOW_HEAD_M
    return None


def head_anchor_height(keypoints, confs, posture):
    """Height above the floor (m) of the point POSE_HEAD_ESTIMATE sends."""
    head = head_point(keypoints, confs)
    below = head[1] if head else 0.0
    return round(HEAD_HEIGHT_M.get(posture, HEAD_HEIGHT_M["UNKNOWN"]) - below, 3)


def hip_anchor_height(posture, mode="POSE_HIP_HEIGHT"):
    """Height above the floor (m) of the point POSE_HIP_HEIGHT or
    POSE_SHOULDER_HEIGHT sends."""
    table = {"POSE_SHOULDER_HEIGHT": SHOULDER_HEIGHT_M, "BOX_TOP_HEIGHT": CROWN_HEIGHT_M}.get(mode, HIP_HEIGHT_M)
    return table.get(posture, table["UNKNOWN"])


def anchor_for(keypoints, confs, box, posture, frame_height=None):
    """Choose the floor-contact pixel and its anchorMode (contract table).

    POSE_ANKLES         ankles visible: the real floor contact.
    POSE_HEAD_ESTIMATE  the box is cut off by the bottom of the frame: the
                        floor is out of the picture, so the head point is
                        sent and the backend places the person from the
                        camera's height (head_anchor_height gives its height).
    BOX_TOP_HEIGHT      the box is cut off by the bottom of the frame: the top
                        of the box (the crown) at its posture height (first
                        choice there; also usable when the box only nearly
                        reaches the edge, see anchor_candidates).
    POSE_SHOULDER_HEIGHT  feet hidden, shoulders seen (someone behind
                        a table): the shoulder midpoint at its posture height
                        (hip_anchor_height); shoulders stay seen and steady
                        when the hips drop behind the table edge.
    POSE_HIP_HEIGHT     feet hidden, shoulders not both seen, hips seen (behind a
                        table): the hip point is sent and the backend places
                        the person from the camera's height, the hips at
                        hip_anchor_height(posture) — robust to leaning over,
                        unlike the head, and to the table edge, unlike the box.
    POSE_HIP_ESTIMATE   feet hidden, knees seen, posture known: floor estimated below hips.
    OCCUPANCY_PROXY     otherwise: bottom-centre of the person box.
    """
    return anchor_candidates(keypoints, confs, box, posture, frame_height)[0]


# A box whose bottom is this close to the frame edge may be the crown case
# frame to frame (BOX_TOP_HEIGHT stays usable here, so a box hovering at the
# edge does not flip between methods).
NEAR_CUT_OFF_PX = 40.0


def anchor_candidates(keypoints, confs, box, posture, frame_height=None):
    """Every usable (point, anchorMode) for this frame, best first; the last
    is always OCCUPANCY_PROXY. anchor_for takes the first; AnchorModeHold
    keeps a track on the method it already uses while that is still usable."""
    x1, y1, x2, y2 = (float(value) for value in box)
    cut_off = frame_height is not None and y2 >= float(frame_height) - CUT_OFF_PX
    near_cut = frame_height is not None and y2 >= float(frame_height) - NEAR_CUT_OFF_PX
    out = []
    # Cut off by the bottom of the frame (sitting right under the camera): the
    # top of the box is the crown of the head, seen even from behind, while
    # the face, shoulders and hips are out of frame or guessed (live: hips
    # "seen" around the arms of a man whose hips were below the frame).
    crown = (((x1 + x2) / 2.0, y1), "BOX_TOP_HEIGHT") if near_cut and y1 > CUT_OFF_PX else None
    if cut_off and crown:
        out.append(crown)
    if keypoints is not None and confs is not None:
        ankles = _visible(confs, (LEFT_ANKLE, RIGHT_ANKLE), ANKLE_CONFIDENCE)
        # Seated, the feet are under the table, ~0.4 m ahead of the body, so
        # they come last (live: ankles vs shoulders put one seated man 0.4 m
        # apart, and he jumped between the two).
        ankle_candidate = None
        if ankles and not cut_off:
            xs = [_point(keypoints, i)[0] for i in ankles]
            ys = [_point(keypoints, i)[1] for i in ankles]
            ankle_candidate = ((sum(xs) / len(xs), max(ys)), "POSE_ANKLES")
        # CROUCHED too: mostly someone seated, seen from behind, whose "ankles"
        # are guesses under the chair (live: 0.3-0.5 m off his chair, every
        # time the pose model saw ankles).
        feet_last = posture in ("SEATED", "CROUCHED")
        if ankle_candidate and not feet_last:
            out.append(ankle_candidate)
        # No floor contact seen: one body point at its posture height, the
        # same choice frame after frame (mixing methods made people jump —
        # 0.7 m on the 15 Oct capture). Shoulders first: seen most, steadiest.
        hips = _visible(confs, (LEFT_HIP, RIGHT_HIP), KEYPOINT_CONFIDENCE)
        shoulders = _visible(confs, (LEFT_SHOULDER, RIGHT_SHOULDER), KEYPOINT_CONFIDENCE)
        # Standing, the hips stay over the feet while the shoulders lean out over
        # a table (live: 0.25 m), so a standing person is placed by the hips.
        height_points = []
        if len(shoulders) == 2:
            height_points.append((_mean_point(keypoints, shoulders), "POSE_SHOULDER_HEIGHT"))
        if len(hips) == 2:
            height_points.insert(0 if posture == "STANDING" else len(height_points),
                                 (_mean_point(keypoints, hips), "POSE_HIP_HEIGHT"))
        out.extend(height_points)
        if ankle_candidate and feet_last:
            out.append(ankle_candidate)
        if cut_off:
            head = head_point(keypoints, confs)
            if head is not None:
                out.append((head[0], "POSE_HEAD_ESTIMATE"))
    if crown and not cut_off:
        out.append(crown)
    if keypoints is not None and confs is not None:
        torso = _torso(keypoints, confs)
        if posture in HIP_TO_FLOOR_TORSOS and torso is not None:
            _, hip_mid, torso_length = torso
            out.append(((hip_mid[0], hip_mid[1] + HIP_TO_FLOOR_TORSOS[posture] * torso_length), "POSE_HIP_ESTIMATE"))
    out.append((((x1 + x2) / 2.0, y2), "OCCUPANCY_PROXY"))
    return out


class AnchorModeHold:
    """Per-track anchor method with a hold: a track keeps the method it uses
    while that method is still usable, and changes only after another has been
    the best for `hold_s`, or at once if its own is no longer usable. Live,
    people standing up at the near end flipped ankles / shoulders / crown
    nearly every frame (each a different floor point: the figure jumped)."""

    def __init__(self, hold_s=1.0):
        self.hold_s = hold_s
        self._tracks = {}

    def choose(self, track_id, candidates, now):
        by_mode = {mode: point for point, mode in reversed(candidates)}
        best_point, best_mode = candidates[0]
        state = self._tracks.get(track_id)
        if state is None or state["mode"] not in by_mode:
            self._tracks[track_id] = {"mode": best_mode, "challenger": None, "since": now}
            return best_point, best_mode
        if best_mode == state["mode"]:
            state["challenger"] = None
        elif state["challenger"] != best_mode:
            state["challenger"], state["since"] = best_mode, now
        elif now - state["since"] >= self.hold_s:
            state.update(mode=best_mode, challenger=None)
        return by_mode[state["mode"]], state["mode"]

    def mode(self, track_id):
        return self._tracks.get(track_id, {}).get("mode")

    def prune(self, keep_ids):
        for track_id in list(self._tracks):
            if track_id not in keep_ids:
                del self._tracks[track_id]


class PostureSmoother:
    """Per-track posture with EMA scores and hysteresis.

    A change of state (including the first one out of UNKNOWN) needs the
    challenger to beat the current state by `margin` for `confirmations`
    consecutive pose updates spanning at least `dwell_s` seconds: one or two
    odd frames never flip a person between seated and standing. With no
    usable pose for `decay_s` seconds the track decays to UNKNOWN.
    """

    def __init__(self, alpha=0.35, margin=0.15, confirmations=2, decay_s=5.0, floor=0.5,
                 hold_s=90.0, hold_tolerance=0.35, dwell_s=0.0, strong=0.75, strong_s=1.0, standing_hold_s=10.0):
        # Occlusion hold: a seated person's legs vanish behind a table for
        # minutes at a time. A CONFIRMED posture stays alive while the
        # shoulders stay within `hold_tolerance` torso lengths of where they
        # were when the posture was last seen with legs — standing up lifts
        # them by about a torso — for at most `hold_s`, with confidence easing
        # down so the backend's 0.5 gate eventually returns it to UNKNOWN.
        self.hold_s = hold_s
        self.hold_tolerance = hold_tolerance
        self.alpha = alpha
        self.margin = margin
        self.confirmations = confirmations
        self.dwell_s = dwell_s
        # Clear, strong evidence (whole legs seen while walking in) confirms
        # after `strong_s` instead of the full dwell, so the occlusion hold
        # has a posture to keep when the legs then vanish behind a table.
        self.strong = strong
        self.strong_s = strong_s
        # STANDING with the legs hidden is held only this long after the last
        # evidence for it: standing still at a table with the legs out of sight
        # for longer is nearly always sitting (live: a man who walked in and sat
        # down kept "standing" — from above, sitting barely lowered his
        # shoulders in the picture, and the table hid his knees).
        self.standing_hold_s = standing_hold_s
        self.decay_s = decay_s
        # The score UNKNOWN "holds" against a first challenger.
        self.floor = floor
        self._tracks = {}

    def update(self, track_id, scores, now, keypoints=None, confs=None):
        """Feed one pose result (None or all-zero = no usable pose).

        keypoints/confs, when given, let a legs-hidden result keep a confirmed
        posture alive (see the occlusion hold in __init__).
        """
        upper = _shoulder_height(keypoints, confs) if keypoints is not None and confs is not None else None
        if not scores or max(scores.get(name, 0.0) for name in POSTURES) <= 0.0:
            state = self._tracks.get(track_id)
            if (state is not None and state["posture"] != "UNKNOWN" and upper is not None
                    and state.get("ref") is not None and now - state["last_pose"] <= self.hold_s):
                ref_y, ref_scale = state["ref"]
                if abs(upper[0] - ref_y) <= self.hold_tolerance * ref_scale:
                    state["last_support"] = now
            return self.current(track_id, now)
        state = self._tracks.get(track_id)
        if state is None:
            state = {"ema": {name: float(scores.get(name, 0.0)) for name in POSTURES},
                     "posture": "UNKNOWN", "challenger": None, "streak": 0, "last_pose": now}
            self._tracks[track_id] = state
        else:
            for name in POSTURES:
                state["ema"][name] = self.alpha * float(scores.get(name, 0.0)) + (1.0 - self.alpha) * state["ema"][name]
            state["last_pose"] = now
        ema = state["ema"]
        best = max(POSTURES, key=lambda name: ema[name])
        raw_best = max(POSTURES, key=lambda name: float(scores.get(name, 0.0)))
        if float(scores.get(raw_best, 0.0)) >= self.strong:
            if state.get("strong_label") != raw_best:
                state["strong_label"], state["strong_since"] = raw_best, now
        else:
            state["strong_label"] = None
        if raw_best == state["posture"] and float(scores.get(raw_best, 0.0)) > 0:
            state["last_agree"] = now
        current = state["posture"]
        if current == "UNKNOWN":
            runner_up = max(ema[name] for name in POSTURES if name != best)
            beats = ema[best] >= self.floor and ema[best] - runner_up >= self.margin
        else:
            beats = best != current and ema[best] - ema[current] >= self.margin
            # Nobody sits down without their shoulders dropping: from STANDING,
            # SEATED needs the shoulders lower than where they stood (by the
            # hold tolerance). Knees guessed behind a table edge alone cannot.
            # Seated seen from above, the shins foreshorten and read as a crouch
            # (live: a seated man flipped SEATED/CROUCHED three times a minute,
            # moving 0.3 m each time as his anchor changed). From SEATED the
            # only way out is standing up.
            if current == "SEATED" and best == "CROUCHED":
                beats = False
            # Nor does anyone stand up without their shoulders rising: from
            # SEATED, STANDING needs the shoulders up by 0.2 torso, or strong
            # evidence (legs seen as they step out). Live, a seated man whose
            # guessed knees scored STANDING 0.4-0.55 was stood up — and placed
            # on the table, his hips taken at standing height.
            if beats and current == "SEATED" and best == "STANDING" and state.get("ref") is not None:
                ref_y, ref_scale = state["ref"]
                risen = upper is not None and ref_y - upper[0] >= 0.2 * ref_scale
                strong = state.get("strong_label") == "STANDING" and now - state.get("strong_since", now) >= self.strong_s
                beats = risen or strong
            if beats and current == "STANDING" and best == "SEATED" and state.get("ref") is not None:
                ref_y, ref_scale = state["ref"]
                beats = upper is not None and upper[0] - ref_y >= self.hold_tolerance * ref_scale
        if beats:
            if state["challenger"] != best:
                state["since"] = now
            state["streak"] = state["streak"] + 1 if state["challenger"] == best else 1
            state["challenger"] = best
            strong_held = state.get("strong_label") == best and now - state.get("strong_since", now) >= min(self.strong_s, self.dwell_s)
            if state["streak"] >= self.confirmations and (now - state.get("since", now) >= self.dwell_s or strong_held):
                state["posture"] = best
                state["challenger"] = None
                state["streak"] = 0
                state["last_agree"] = now
        else:
            state["challenger"] = None
            state["streak"] = 0
        # The reference is where the shoulders are while the evidence agrees
        # with the posture, not while something challenges it.
        if upper is not None and state["posture"] != "UNKNOWN" and raw_best == state["posture"]:
            state["ref"] = upper
        state["last_support"] = now
        return self.current(track_id, now)

    def current(self, track_id, now):
        state = self._tracks.get(track_id)
        if state is None:
            return "UNKNOWN", 0.0
        if now - max(state["last_pose"], state.get("last_support", state["last_pose"])) > self.decay_s:
            del self._tracks[track_id]
            return "UNKNOWN", 0.0
        if state["posture"] == "STANDING" and now - state.get("last_agree", state["last_pose"]) > self.standing_hold_s:
            state["posture"] = "UNKNOWN"
            state["ema"] = {name: 0.0 for name in POSTURES}
            state["challenger"], state["streak"] = None, 0
        if state["posture"] == "UNKNOWN":
            return "UNKNOWN", 0.0
        # A confirmed posture has beaten every challenger: weak contrary frames
        # (guessed knees) wear its average down but not below the floor, or the
        # backend's 0.5 gate would drop a man standing at the table to UNKNOWN.
        # From 0.75, the occlusion hold's easing below takes ~30 s to reach 0.5.
        confidence = max(_clamp(state["ema"][state["posture"]]), 0.75)
        held = now - state["last_pose"]
        if held > self.decay_s:
            confidence *= max(0.0, 1.0 - held / self.hold_s)
        return state["posture"], round(confidence, 3)

    def lean(self, track_id, now, minimum=0.4):
        """Which way the evidence leans before a posture is confirmed: the
        smoothed leader when it beats the runner-up by `margin`, else UNKNOWN.
        Live: a man standing bent over the table (knees seen, STANDING 0.65 vs
        SEATED 0.35) was UNKNOWN for the dwell, so he was placed at seated
        heights and drawn "probably seated". The confirmed posture still wins."""
        posture, confidence = self.current(track_id, now)
        if posture != "UNKNOWN":
            return posture, confidence
        state = self._tracks.get(track_id)
        if state is None:
            return "UNKNOWN", 0.0
        ema = state["ema"]
        best = max(POSTURES, key=lambda name: ema[name])
        runner_up = max(ema[name] for name in POSTURES if name != best)
        if ema[best] >= minimum and ema[best] - runner_up >= self.margin:
            return best, round(_clamp(ema[best]), 3)
        return "UNKNOWN", 0.0

    def prune(self, now, keep_ids=None):
        for track_id in list(self._tracks):
            state = self._tracks[track_id]
            stale = now - max(state["last_pose"], state.get("last_support", state["last_pose"])) > self.decay_s
            if stale or (keep_ids is not None and track_id not in keep_ids):
                del self._tracks[track_id]


class AnchorStabilizer:
    """Per-track floor-anchor smoothing with a dead-band.

    A seated person's detection box changes every frame — an arm moves, the
    chair is half hidden — and its bottom edge (or the hip estimate) jumps by
    tens of pixels, which the floor mapping turns into a person sliding around
    the room. Inside a dead-band of `deadband` box heights the anchor only
    drifts slowly toward the new point; a move beyond it has to persist for
    `confirmations` frames (or be very large) before the anchor follows. Real
    walking is several dead-bands per second, so it is followed within a frame
    or two.
    """

    def __init__(self, deadband=0.12, drift=0.12, follow=0.65, confirmations=2, jump=3.0, forget_s=6.0):
        self.deadband = deadband
        self.drift = drift
        self.follow = follow
        self.confirmations = confirmations
        self.jump = jump
        self.forget_s = forget_s
        self._tracks = {}

    def update(self, track_id, point, box_height, now):
        x, y = float(point[0]), float(point[1])
        band = max(4.0, self.deadband * max(1.0, float(box_height)))
        state = self._tracks.get(track_id)
        if state is None or now - state["t"] > self.forget_s:
            self._tracks[track_id] = {"x": x, "y": y, "t": now, "outside": 0}
            return x, y
        dx, dy = x - state["x"], y - state["y"]
        distance = math.hypot(dx, dy)
        if distance <= band:
            state["outside"] = 0
            state["x"] += dx * self.drift
            state["y"] += dy * self.drift
        else:
            state["outside"] += 1
            if state["outside"] >= self.confirmations or distance >= self.jump * band:
                state["x"] += dx * self.follow
                state["y"] += dy * self.follow
                state["outside"] = 0
        state["t"] = now
        return state["x"], state["y"]

    def forget(self, track_id):
        """Start afresh, e.g. when the anchor method changes: a crown pixel and
        a shoulder pixel are different points and must not be blended."""
        self._tracks.pop(track_id, None)

    def prune(self, now, keep_ids=None):
        for track_id in list(self._tracks):
            if now - self._tracks[track_id]["t"] > self.forget_s or (keep_ids is not None and track_id not in keep_ids):
                del self._tracks[track_id]


# ── body keypoints for the twin's rig ─────────────────────────────────────────

LEFT_ELBOW, RIGHT_ELBOW = 7, 8
LEFT_WRIST, RIGHT_WRIST = 9, 10


class KeypointSmoother:
    """Per-track EMA of the 17 keypoints, in coordinates relative to the
    person's box (bottom-centre origin, box-height units) so a person walking
    does not smear their own arms. Low-confidence points keep their previous
    smoothed value but lose confidence; the rig blends those back to its
    default pose rather than trusting a guess."""

    def __init__(self, alpha=0.5, min_conf=0.3, forget_s=3.0):
        self.alpha = alpha
        self.min_conf = min_conf
        self.forget_s = forget_s
        self._tracks = {}

    @staticmethod
    def _frame(box):
        x1, y1, x2, y2 = box
        return (x1 + x2) / 2.0, y2, max(1.0, y2 - y1)

    def update(self, track_id, keypoints, confs, box, now):
        cx, by, h = self._frame(box)
        rel = [((x - cx) / h, (y - by) / h) for x, y in keypoints]
        state = self._tracks.get(track_id)
        if state is None or now - state["t"] > self.forget_s:
            state = {"rel": rel, "conf": [float(c) for c in confs], "t": now}
            self._tracks[track_id] = state
        else:
            for i, (point, conf) in enumerate(zip(rel, confs)):
                if conf >= self.min_conf:
                    ox, oy = state["rel"][i]
                    state["rel"][i] = (ox + (point[0] - ox) * self.alpha, oy + (point[1] - oy) * self.alpha)
                    state["conf"][i] = state["conf"][i] + (float(conf) - state["conf"][i]) * self.alpha
                else:
                    state["conf"][i] *= 0.6
            state["t"] = now

    def current(self, track_id, box, now):
        """[(x, y, conf)] in frame pixels for the person's current box, or None."""
        state = self._tracks.get(track_id)
        if state is None or now - state["t"] > self.forget_s:
            return None
        cx, by, h = self._frame(box)
        return [(cx + rx * h, by + ry * h, c) for (rx, ry), c in zip(state["rel"], state["conf"])]

    def prune(self, now, keep_ids=None):
        for track_id in list(self._tracks):
            if now - self._tracks[track_id]["t"] > self.forget_s or (keep_ids is not None and track_id not in keep_ids):
                del self._tracks[track_id]


GESTURES = ("HAND_AT_HEAD", "HANDS_FORWARD", "HAND_RAISED")


def classify_gestures(keypoints, confs, posture="UNKNOWN"):
    """Arm gestures visible in COCO-17 geometry, scored 0..1.

    These describe what the arms are doing, never an activity: a hand at the
    head is not proof of a phone call, hands forward is not proof of typing.
    - HAND_AT_HEAD: a wrist within ~0.45 torso of an ear/nose, above the
      shoulders, with the elbow bent.
    - HAND_RAISED: a wrist clearly above the head.
    - HANDS_FORWARD: both wrists visible between shoulder and hip height with
      bent elbows — the shape of working at a desk or holding something in
      front of the body.
    """
    scores = {name: 0.0 for name in GESTURES}
    torso = _torso(keypoints, confs)
    if torso is None:
        return scores
    shoulder_mid, hip_mid, t = torso
    head_points = _visible(confs, (NOSE, LEFT_EAR, RIGHT_EAR, LEFT_EYE, RIGHT_EYE))
    sides = ((LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST), (RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST))
    at_head, raised, forward = [], [], []
    for shoulder, elbow, wrist in sides:
        if _conf(confs, wrist) < KEYPOINT_CONFIDENCE or _conf(confs, shoulder) < KEYPOINT_CONFIDENCE:
            continue
        w = _point(keypoints, wrist)
        s = _point(keypoints, shoulder)
        quality = min(_conf(confs, wrist), _conf(confs, shoulder))
        bent = None
        if _conf(confs, elbow) >= KEYPOINT_CONFIDENCE:
            bent = _angle(s, _point(keypoints, elbow), w)
        if head_points:
            nearest = min(math.hypot(w[0] - _point(keypoints, i)[0], w[1] - _point(keypoints, i)[1]) for i in head_points)
            closeness = 1.0 - _ramp(nearest / t, 0.3, 0.55)
            above = 1.0 if w[1] < s[1] else 0.0
            elbow_ok = 1.0 if bent is None or bent < 110 else 0.3
            at_head.append(closeness * above * elbow_ok * quality)
            top = min(_point(keypoints, i)[1] for i in head_points)
            raised.append(_ramp((top - w[1]) / t, 0.05, 0.3) * quality)
        between = 1.0 if s[1] < w[1] < hip_mid[1] + 0.35 * t else 0.0
        elbow_bent = 1.0 if bent is not None and 45 <= bent <= 135 else 0.0
        forward.append(between * elbow_bent * quality)
    if at_head:
        scores["HAND_AT_HEAD"] = round(max(at_head), 4)
    if raised:
        scores["HAND_RAISED"] = round(max(raised), 4)
    if len(forward) == 2:
        scores["HANDS_FORWARD"] = round(min(forward), 4)
    # A hand at the head wins over "raised" when both fire.
    if scores["HAND_AT_HEAD"] > 0.5:
        scores["HAND_RAISED"] *= 0.3
    return scores


class EvidenceSmoother:
    """Per-track, per-label EMA with hysteresis: a label switches on when the
    smoothed score passes `on` for `confirmations` consecutive updates, and off
    when it falls below `off`. Old tracks are forgotten after `forget_s`."""

    def __init__(self, alpha=0.45, on=0.55, off=0.3, confirmations=2, forget_s=5.0):
        self.alpha, self.on, self.off = alpha, on, off
        self.confirmations, self.forget_s = confirmations, forget_s
        self._tracks = {}

    def update(self, track_id, scores, now):
        state = self._tracks.setdefault(track_id, {"ema": {}, "active": set(), "streak": {}, "t": now})
        state["t"] = now
        for name, score in scores.items():
            ema = state["ema"].get(name, 0.0)
            ema = ema + (float(score) - ema) * self.alpha
            state["ema"][name] = ema
            if name in state["active"]:
                if ema < self.off:
                    state["active"].discard(name)
                state["streak"][name] = 0
            elif ema >= self.on:
                state["streak"][name] = state["streak"].get(name, 0) + 1
                if state["streak"][name] >= self.confirmations:
                    state["active"].add(name)
                    state["streak"][name] = 0
            else:
                state["streak"][name] = 0
        return self.current(track_id, now)

    def current(self, track_id, now):
        state = self._tracks.get(track_id)
        if state is None or now - state["t"] > self.forget_s:
            return []
        return [{"kind": name, "confidence": round(min(1.0, state["ema"][name]), 3)} for name in sorted(state["active"])]

    def prune(self, now, keep_ids=None):
        for track_id in list(self._tracks):
            if now - self._tracks[track_id]["t"] > self.forget_s or (keep_ids is not None and track_id not in keep_ids):
                del self._tracks[track_id]


# ── objects: only what is seen repeatedly ─────────────────────────────────────

# Minimum per-detection confidence by type. On the 640x360 Conference Room
# substream the COCO detector labelled a pink plastic bag "potted plant" at
# 0.59 and missed an open laptop entirely, so single detections are never
# shown: a type must also be confirmed across repeated scans.
OBJECT_MIN_CONFIDENCE = {
    "LAPTOP": 0.35, "KEYBOARD": 0.35, "MONITOR": 0.4, "PHONE": 0.4,
    # Clear bottles in a cluster score low; the 3-of-5 confirmation still guards.
    "CUP": 0.4, "BOTTLE": 0.25, "MOUSE": 0.4, "BACKPACK": 0.4,
    "HANDBAG": 0.4, "CHAIR": 0.35, "NOTEBOOK": 0.4,
}


class ObjectConfirmer:
    """Associates detections across scans by type and box overlap and reports
    an object only once it was seen in at least `need` of the last `window`
    scans with enough confidence. An object drops out after `forget_s`
    without a sighting. Stable ids let the twin keep one object steady.

    Once confirmed it stays reported until unseen for `keep_s` — live, objects
    blinked in and out as their hit count crossed the threshold scan to scan."""

    def __init__(self, need=3, window=5, iou=0.3, forget_s=20.0, thresholds=None, keep_s=12.0):
        self.need, self.window, self.iou, self.forget_s = need, window, iou, forget_s
        self.keep_s = keep_s
        self._now = 0.0
        self.thresholds = thresholds or OBJECT_MIN_CONFIDENCE
        self._objects = {}
        self._next = 1
        self._scans = 0

    @staticmethod
    def _iou(a, b):
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / union if union > 0 else 0.0

    def update(self, detections, now):
        """detections: [(type, confidence, (x1, y1, x2, y2))] from one scan."""
        self._scans += 1
        matched = set()
        for kind, confidence, box in detections:
            if kind not in self.thresholds or confidence < self.thresholds[kind]:
                continue
            # Same type, overlapping — or, for a box that shifted, its centre
            # within half a box of the old one: the same object (live, a cup
            # re-detected with a new box got a new id, so one vanished and
            # another appeared in its place).
            best, best_score = None, 0.0
            cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
            size = max(1.0, math.hypot(box[2] - box[0], box[3] - box[1]))
            for oid, obj in self._objects.items():
                if obj["type"] != kind or oid in matched:
                    continue
                overlap = self._iou(obj["box"], box)
                ox, oy = (obj["box"][0] + obj["box"][2]) / 2.0, (obj["box"][1] + obj["box"][3]) / 2.0
                near = 1.0 - math.hypot(cx - ox, cy - oy) / (0.5 * size)
                score = overlap if overlap >= self.iou else (0.5 * near if near > 0 else 0.0)
                if score > best_score:
                    best, best_score = oid, score
            if best is None:
                best = f"{kind.lower()}-{self._next}"
                self._next += 1
                self._objects[best] = {"type": kind, "box": box, "hits": [], "conf": confidence, "t": now}
            obj = self._objects[best]
            obj["box"] = tuple(o + (n - o) * 0.5 for o, n in zip(obj["box"], box))
            obj["conf"] = obj["conf"] + (confidence - obj["conf"]) * 0.5
            obj["hits"].append(self._scans)
            obj["t"] = now
            matched.add(best)
        self._now = now
        for oid in list(self._objects):
            obj = self._objects[oid]
            obj["hits"] = [h for h in obj["hits"] if h > self._scans - self.window]
            if len(obj["hits"]) >= self.need:
                obj["confirmed"] = True
            if obj.get("confirmed"):
                if now - obj["t"] > min(self.keep_s, self.forget_s):
                    del self._objects[oid]
            elif now - obj["t"] > self.forget_s or (not obj["hits"] and now - obj["t"] > 2.0):
                del self._objects[oid]
        return self.confirmed()

    def confirmed(self):
        return [
            {"id": oid, "type": obj["type"], "box": obj["box"], "confidence": round(obj["conf"], 3), "confirmations": len(obj["hits"])}
            for oid, obj in self._objects.items() if obj.get("confirmed") or len(obj["hits"]) >= self.need
        ]


# Adult proportions, as fractions of the same body's measures: a hand (wrist
# to fingertip) is about 0.19 m; shoulder joint to hip joint about 0.5 m;
# shoulder joint to shoulder joint about 0.36 m.
HAND_PER_TORSO = 0.38
HAND_PER_SHOULDERS = 0.52


def hand_length_px(keypoints, confs):
    """This person's hand length in image pixels, or None.

    Estimated from the torso and from the shoulders, taking the larger: a
    camera only ever shortens a body part (leaning toward it shortens the
    torso, turning sideways the shoulders), so the longer estimate is the
    less foreshortened one. Live, a man leaning over the table had a 57-84 px
    torso beside 120 px shoulders, and his hips dropped in and out of view;
    on the torso alone his hand measured half its size, or nothing."""
    estimates = []
    torso = _torso(keypoints, confs)
    if torso is not None:
        estimates.append(torso[2] * HAND_PER_TORSO)
    if len(_visible(confs, (LEFT_SHOULDER, RIGHT_SHOULDER))) == 2:
        (ax, ay), (bx, by) = _point(keypoints, LEFT_SHOULDER), _point(keypoints, RIGHT_SHOULDER)
        estimates.append(math.hypot(ax - bx, ay - by) * HAND_PER_SHOULDERS)
    best = max(estimates, default=0.0)
    return best if best > 1.0 else None


def _box_to_point(box, x, y):
    x1, y1, x2, y2 = box
    return math.hypot(max(x1 - x, 0.0, x - x2), max(y1 - y, 0.0, y - y2))


def _box_to_segment(box, a, b, samples=8):
    """Distance from a box to the segment a-b (0 when they touch)."""
    return min(_box_to_point(box, a[0] + (b[0] - a[0]) * i / samples, a[1] + (b[1] - a[1]) * i / samples)
               for i in range(samples + 1))


def _phone_sure(obj):
    """How much a phone detection counts: full from 0.5. A phone in a hand is
    half covered by fingers and scores 0.35-0.66 (live); it is already
    confirmed across scans before it reaches here."""
    return min(1.0, obj["confidence"] / 0.5)


def _held_by(keypoints, confs, wrist, elbow, box, hand):
    """0..1: how well a phone box sits in one hand.

    The hand runs from the wrist one hand length on along the forearm
    (elbow -> wrist), so a phone gripped in the fingers lies beyond the wrist
    point, not on it. Where the elbow is not trustworthy, only a tight circle
    round the wrist counts: arms are the least reliable keypoints (live, an
    elbow was put above its own wrist, beside the phone). Off the hand's line,
    the phone must touch the palm: half a palm is about 0.2 hand lengths."""
    wx, wy = _point(keypoints, wrist)
    near = 1.0 - _ramp(_box_to_point(box, wx, wy) / hand, 0.3, 0.6)
    if _conf(confs, elbow) >= 0.5:
        ex, ey = _point(keypoints, elbow)
        forearm = math.hypot(wx - ex, wy - ey)
        if forearm >= 0.5 * hand:
            tip = (wx + (wx - ex) / forearm * hand, wy + (wy - ey) / forearm * hand)
            along = 1.0 - _ramp(_box_to_segment(box, (wx, wy), tip) / hand, 0.2, 0.4)
            near = max(near, along)
    return near


def hand_object_scores(keypoints, confs, objects):
    """{"PHONE_IN_HAND": score} for one person from where their hands are and
    the confirmed phones near them. Distances are in this person's own hand
    lengths (hand_length_px), so the rule is the same near the camera and far
    from it, seated behind a table or standing. Evidence from both hands
    combines: a phone in both hands is surer than one in either."""
    hand = hand_length_px(keypoints, confs)
    if hand is None:
        return {"PHONE_IN_HAND": 0.0}
    best = 0.0
    for obj in objects:
        if obj["type"] != "PHONE":
            continue
        missed = 1.0
        for wrist, elbow in ((LEFT_WRIST, LEFT_ELBOW), (RIGHT_WRIST, RIGHT_ELBOW)):
            if _conf(confs, wrist) < 0.5:
                continue
            missed *= 1.0 - _held_by(keypoints, confs, wrist, elbow, obj["box"], hand) * _conf(confs, wrist)
        best = max(best, (1.0 - missed) * _phone_sure(obj))
    return {"PHONE_IN_HAND": round(best, 4)}


class StaticObjectMap:
    """Furniture and desk objects: a long memory of them, not a live track.

    Live, the chairs people sat on were half hidden by them, scored near the
    threshold scan to scan, dropped out and came back under new ids (10
    changes in two still minutes); each time the twin re-seated the sitter,
    who jumped 0.3-0.5 m and turned. Here a chair is matched across scans by
    box overlap (or a nearby centre), confirmed after `need` sightings,
    reported at the median of its recent boxes, and kept for `keep_s` after it
    was last seen — a person sitting in front of it does not erase it.
    Sightings from more than one detector feed the same map. Matching is per
    type; `keep_s` and `min_conf` may be per type ({type: value}) — the same
    id churn made cups and bottles blink out and back (20 times in 100 s).
    """

    # A chair is never tiny in this room's picture: a 12 x 16 px "chair" on the
    # table edge (in the 640 x 360 calibration image) was mapped beside a real
    # one (live). Minimum box height in px of the worker's frame.
    MIN_HEIGHT_PX = {"CHAIR": 48.0}

    def __init__(self, need=3, keep_s=120.0, min_conf=0.3, iou=0.3, history=15, unconfirmed_s=40.0, prefix="obj"):
        self.need, self.keep_s, self.min_conf, self.iou = need, keep_s, min_conf, iou
        self.history, self.unconfirmed_s, self.prefix = history, unconfirmed_s, prefix
        self._chairs = {}
        self._next = 1

    def _keep(self, kind):
        return self.keep_s.get(kind, 60.0) if isinstance(self.keep_s, dict) else self.keep_s

    def _min_conf(self, kind):
        return self.min_conf.get(kind, 0.35) if isinstance(self.min_conf, dict) else self.min_conf

    @staticmethod
    def _median_box(boxes):
        return tuple(sorted(b[i] for b in boxes)[len(boxes) // 2] for i in range(4))

    @staticmethod
    def _contained(a, b):
        """Share of the smaller box inside the other."""
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
        return ix * iy / small if small > 0 else 0.0

    # A laptop's own keys, screen or touchpad read as a keyboard, monitor or
    # mouse on its box: not another object (live: two "laptops" stacked; an
    # open laptop's screen, 43% on the laptop's box, as a "monitor").
    PARTS_OF = {"KEYBOARD": "LAPTOP", "MONITOR": "LAPTOP", "MOUSE": "LAPTOP"}
    # One bag read as a backpack by one scan and a handbag by another is one
    # bag (live: both drawn, stacked, for a backpack on the table).
    FAMILY = {"HANDBAG": "BAG", "BACKPACK": "BAG"}
    # A part of a chair (its back, one side) seen inside the box of the whole
    # chair is that chair (live: the chair under a sitter was mapped twice);
    # 70%, since chairs side by side overlap in the image. A laptop half hidden
    # by the person at it is detected as its screen or its keys alone: 30%.
    PART_SHARE = {"CHAIR": 0.7, "TABLE": 0.7, "LAPTOP": 0.3}
    # Published only once its running confidence reaches this. Live, a
    # "laptop" at 0.44-0.55 came back at the same far-end spot in four
    # recordings, with no laptop there; real laptops ran 0.75-0.96.
    PUBLISH_MIN_CONF = {"LAPTOP": 0.6}

    def _part_of(self, kind, a, b):
        """One box is part of the other object of this kind: mostly inside it,
        or (a laptop) its screen above its keys, one directly over the other."""
        share = self.PART_SHARE.get(kind)
        if share is None:
            return False
        if self._contained(a, b) >= share:
            return True
        if kind != "LAPTOP":
            return False
        x_overlap = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) / max(1.0, min(a[2] - a[0], b[2] - b[0]))
        gap = max(a[1], b[1]) - min(a[3], b[3])
        return x_overlap >= 0.6 and gap <= 0.15 * (max(a[3], b[3]) - min(a[1], b[1]))

    def _same_kind(self, a, b):
        return a == b or (a in self.FAMILY and self.FAMILY.get(a) == self.FAMILY.get(b))

    def _score(self, chair_box, box, kind=None):
        if self._part_of(kind, chair_box, box):
            return 0.9
        overlap = ObjectConfirmer._iou(chair_box, box)
        if overlap >= self.iou:
            return overlap
        cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
        ox, oy = (chair_box[0] + chair_box[2]) / 2.0, (chair_box[1] + chair_box[3]) / 2.0
        size = max(1.0, math.hypot(box[2] - box[0], box[3] - box[1]))
        near = 1.0 - math.hypot(cx - ox, cy - oy) / (0.5 * size)
        return 0.5 * near if near > 0 else 0.0

    def update(self, detections, now):
        """detections: [(type, confidence, (x1, y1, x2, y2))] from one scan
        (or [(confidence, box)] for a single-type map)."""
        matched = set()
        rows = [(d if len(d) == 3 else (None, d[0], d[1])) for d in detections]
        for kind, confidence, box in sorted(rows, key=lambda d: -d[1]):
            if confidence < self._min_conf(kind):
                continue
            if box[3] - box[1] < self.MIN_HEIGHT_PX.get(kind or self.prefix.upper(), 0.0):
                continue
            best, best_score, taken = None, 0.0, False
            for cid, chair in self._chairs.items():
                if not self._same_kind(chair["type"], kind):
                    continue
                score = self._score(self._median_box(chair["boxes"]), box, kind)
                if cid in matched:
                    taken = taken or score > 0
                elif score > best_score:
                    best, best_score = cid, score
            # A second box on an object this scan already matched (two models,
            # or a part and the whole) is that object again, not a new one.
            if best is None and taken:
                continue
            if best is None:
                best = f"{(kind or self.prefix).lower()}-map-{self._next}"
                self._next += 1
                self._chairs[best] = {"boxes": [], "hits": 0, "first": now, "conf": confidence, "type": kind}
            chair = self._chairs[best]
            chair["boxes"] = (chair["boxes"] + [tuple(box)])[-self.history:]
            chair["hits"] += 1
            chair["conf"] = chair["conf"] + (confidence - chair["conf"]) * 0.3
            chair["last"] = now
            matched.add(best)
        for cid in list(self._chairs):
            chair = self._chairs[cid]
            confirmed = chair["hits"] >= self.need
            if now - chair["last"] > (self._keep(chair["type"]) if confirmed else self.unconfirmed_s):
                del self._chairs[cid]
        # Two entries that became the same chair (a split detection): keep the older.
        ids = sorted(self._chairs, key=lambda c: self._chairs[c]["first"])
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if a not in self._chairs or b not in self._chairs or not self._same_kind(self._chairs[a]["type"], self._chairs[b]["type"]):
                    continue
                box_a, box_b = self._median_box(self._chairs[a]["boxes"]), self._median_box(self._chairs[b]["boxes"])
                if ObjectConfirmer._iou(box_a, box_b) >= 0.5 or self._part_of(self._chairs[a]["type"], box_a, box_b):
                    keep = self._chairs[a]
                    keep["hits"] += self._chairs[b]["hits"]
                    keep["last"] = max(keep["last"], self._chairs[b]["last"])
                    del self._chairs[b]
        return self.confirmed()

    def confirmed(self):
        out = [
            {"id": cid, "type": chair["type"] or "CHAIR", "box": self._median_box(chair["boxes"]), "confidence": round(chair["conf"], 3),
             "confirmations": min(99, chair["hits"])}
            for cid, chair in self._chairs.items()
            if chair["hits"] >= self.need and chair["conf"] >= self.PUBLISH_MIN_CONF.get(chair["type"], 0.0)
        ]
        wholes = [o for o in out if o["type"] in self.PARTS_OF.values()]
        return [o for o in out if not (o["type"] in self.PARTS_OF and any(
            w["type"] == self.PARTS_OF[o["type"]] and self._part_of(w["type"], w["box"], o["box"])
            and (o["box"][2] - o["box"][0]) * (o["box"][3] - o["box"][1]) <= (w["box"][2] - w["box"][0]) * (w["box"][3] - w["box"][1])
            for w in wholes))]


def ChairMap(**kwargs):
    """A StaticObjectMap of chairs only (kept 2 minutes unseen)."""
    kwargs.setdefault("prefix", "chair")
    return StaticObjectMap(**kwargs)


# How long a desk object is remembered unseen, by type: furniture and laptops
# stay; a phone is picked up and carried, so it goes quickly.
STATIC_KEEP_S = {"CHAIR": 120.0, "LAPTOP": 60.0, "MONITOR": 120.0, "KEYBOARD": 60.0, "MOUSE": 45.0, "BOTTLE": 60.0,
                 "CUP": 45.0, "NOTEBOOK": 45.0, "BACKPACK": 60.0, "HANDBAG": 45.0, "PHONE": 15.0}


class TrackStitcher:
    """One camera-local id per body across tracker id switches.

    On a low-resolution feed the tracker often loses a seated or half-hidden
    person for a few frames and then starts a new id for the same body; the
    twin would show a new person (and, while the old one is held, two). When a
    new tracker id appears where a recently lost one was last seen (bottom
    centres within ~0.6 box heights, similar size), it inherits the lost one's
    id. Ids still visible this frame are never taken. Anonymous: this only
    joins boxes; it never names anyone.
    """

    def __init__(self, hold_s=6.0, max_offset=0.6, growth_per_s=0.15, size_ratio=1.8):
        self.hold_s = hold_s
        self.max_offset = max_offset
        self.growth_per_s = growth_per_s
        self.size_ratio = size_ratio
        self.stable_of = {}  # tracker id -> stable id
        self.last = {}  # stable id -> (t, box)

    @staticmethod
    def _anchor(box):
        x1, y1, x2, y2 = box
        return (x1 + x2) / 2.0, y2, max(1.0, y2 - y1)

    def resolve(self, boxes, now):
        """boxes: {tracker_id: (x1, y1, x2, y2)} -> {tracker_id: stable_id}."""
        self.last = {s: v for s, v in self.last.items() if now - v[0] <= self.hold_s}
        alive = set(self.last)
        self.stable_of = {raw: s for raw, s in self.stable_of.items() if s in alive or raw in boxes}
        out = {}
        for raw in boxes:
            if raw in self.stable_of:
                out[raw] = self.stable_of[raw]
        taken = set(out.values())
        for raw, box in boxes.items():
            if raw in out:
                continue
            cx, cy, h = self._anchor(box)
            best = None
            for stable, (t, old) in self.last.items():
                if stable in taken:
                    continue
                ox, oy, oh = self._anchor(old)
                if max(h, oh) / min(h, oh) > self.size_ratio:
                    continue
                offset = math.hypot(cx - ox, cy - oy) / max(h, oh)
                limit = self.max_offset + self.growth_per_s * (now - t)
                if offset <= limit and (best is None or offset < best[0]):
                    best = (offset, stable)
            stable = best[1] if best else str(raw)
            self.stable_of[raw] = stable
            out[raw] = stable
            taken.add(stable)
        for raw, box in boxes.items():
            self.last[out[raw]] = (now, box)
        return out


class TrackAdmission:
    """Publish a camera-local track only once it has been a person for a while.

    A chair with a jacket, a reflection or a bag can pass the person detector
    for a few frames; those became a fourth, flickering figure. A track is
    admitted after `admit_s` seconds in which it was seen in at least
    `min_fraction` of the processed frames with mean detection confidence at
    least `min_confidence` (a hand on a laptop at the frame edge passed as a
    person at 0.44); once admitted it stays admitted while it lives
    (occlusion holds still apply). Stale tracks are forgotten after `forget_s`.
    """

    def __init__(self, admit_s=2.0, min_fraction=0.6, min_confidence=0.5, forget_s=10.0):
        self.admit_s, self.min_fraction, self.min_confidence, self.forget_s = admit_s, min_fraction, min_confidence, forget_s
        self._tracks = {}
        self._frames = []  # times of processed frames

    def update(self, seen, now):
        """seen: {track_id: confidence} for this frame. Returns the admitted ids among them."""
        self._frames.append(now)
        horizon = now - max(self.admit_s, self.forget_s)
        self._frames = [t for t in self._frames if t >= horizon]
        for track_id, confidence in seen.items():
            state = self._tracks.setdefault(track_id, {"first": now, "hits": [], "admitted": False})
            state["hits"].append((now, float(confidence)))
            state["last"] = now
        for track_id in list(self._tracks):
            state = self._tracks[track_id]
            if now - state["last"] > self.forget_s:
                del self._tracks[track_id]
                continue
            if state["admitted"] or now - state["first"] < self.admit_s:
                continue
            window = [h for h in state["hits"] if h[0] >= now - self.admit_s]
            frames = [t for t in self._frames if t >= now - self.admit_s]
            if not frames or not window:
                continue
            fraction = len(window) / len(frames)
            mean = sum(c for _, c in window) / len(window)
            if fraction >= self.min_fraction and mean >= self.min_confidence:
                state["admitted"] = True
            state["hits"] = window
        return {track_id for track_id in seen if self._tracks.get(track_id, {}).get("admitted")}

    def admitted(self, track_id):
        return bool(self._tracks.get(track_id, {}).get("admitted"))


# ── clothing colour (anonymous appearance) ───────────────────────────────────

def _region_colour(frame, quad, shrink=0.25):
    """Median colour (RGB hex) inside a quadrilateral of pixel points, shrunk
    toward its centre so edges (arms, background) do not leak in; or None."""
    import numpy as np
    import cv2
    pts = np.array(quad, dtype=np.float32)
    centre = pts.mean(axis=0)
    pts = centre + (pts - centre) * (1.0 - shrink)
    mask = np.zeros(frame.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(mask, pts.astype(np.int32), 1)
    pixels = frame[mask.astype(bool)]
    if len(pixels) < 30:
        return None
    b, g, r = (int(v) for v in np.median(pixels, axis=0))
    return f"#{r:02x}{g:02x}{b:02x}"


def clothing_colours(frame, keypoints, confs):
    """{"shirt": "#rrggbb", "trousers": "#rrggbb" | None} from the torso
    (shoulders to hips) and thighs (hips to knees) of a COCO-17 pose. Colour
    only — no image is kept. None when the torso is not clearly seen."""
    if keypoints is None or confs is None:
        return None
    if min(_conf(confs, i) for i in (LEFT_SHOULDER, RIGHT_SHOULDER)) < KEYPOINT_CONFIDENCE:
        return None
    if min(_conf(confs, i) for i in (LEFT_HIP, RIGHT_HIP)) < KEYPOINT_CONFIDENCE:
        # Hips hidden (behind the table, or hunched over it): the chest just
        # below the shoulders is still shirt (live: a man in green was drawn in
        # the default tint for the whole session).
        ls, rs = _point(keypoints, LEFT_SHOULDER), _point(keypoints, RIGHT_SHOULDER)
        width = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
        if width < 8:
            return None
        drop = 0.8 * width
        shirt = _region_colour(frame, [ls, rs, (rs[0], rs[1] + drop), (ls[0], ls[1] + drop)])
        return {"shirt": shirt, "trousers": None} if shirt else None
    ls, rs, lh, rh = (_point(keypoints, i) for i in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP))
    shirt = _region_colour(frame, [ls, rs, rh, lh])
    if shirt is None:
        return None
    trousers = None
    if min(_conf(confs, LEFT_KNEE), _conf(confs, RIGHT_KNEE)) >= KEYPOINT_CONFIDENCE:
        trousers = _region_colour(frame, [lh, rh, _point(keypoints, RIGHT_KNEE), _point(keypoints, LEFT_KNEE)])
    return {"shirt": shirt, "trousers": trousers}


class AppearanceSmoother:
    """Per-track median of the last `keep` clothing colours, so lighting
    flicker and a hand across the chest do not recolour a person."""

    def __init__(self, keep=9, forget_s=30.0):
        self.keep, self.forget_s = keep, forget_s
        self._tracks = {}

    def update(self, track_id, colours, now):
        if not colours:
            return
        state = self._tracks.setdefault(track_id, {"shirt": [], "trousers": [], "t": now})
        state["t"] = now
        for part in ("shirt", "trousers"):
            if colours.get(part):
                state[part] = (state[part] + [colours[part]])[-self.keep:]

    def current(self, track_id, now):
        state = self._tracks.get(track_id)
        if state is None or now - state["t"] > self.forget_s:
            return None
        def median_hex(values):
            if not values:
                return None
            channels = [sorted(int(v[i:i + 2], 16) for v in values) for i in (1, 3, 5)]
            return "#" + "".join(f"{c[len(c) // 2]:02x}" for c in channels)
        shirt = median_hex(state["shirt"])
        return {"shirt": shirt, "trousers": median_hex(state["trousers"])} if shirt else None
