#!/usr/bin/env python3
"""Publish people, optional face-confirmed identity, and room objects to the twin.

YOLO finds people, BoT-SORT supplies camera-local transient IDs, and only a
floor-contact pixel per person is sent to the CMS. When explicitly enabled, a
read-only adapter may attach a name after repeated direct matches against the
trusted PHONE_DETC face gallery. It never enrols or stores frames. The server
owns calibration and decides whether a point is safe to render.

A lightweight pose model runs on person crops (about once per --pose-interval
per track) to supply posture, camera-relative orientation and a better floor
anchor. Posture is evidence or UNKNOWN: without pose (--no-pose, or the model
failing to load) the worker runs people-only and asserts no posture.
Contract: docs/decisions/cctv-twin-posture-layout-contract.md.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import threading
import sys
import time
import urllib.parse

import cv2
import numpy as np
import requests
from ultralytics import YOLO, YOLOWorld

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cctv_twin_pose import (  # noqa: E402
    AnchorModeHold, AnchorStabilizer, AppearanceSmoother, STATIC_KEEP_S, StaticObjectMap, EvidenceSmoother, KeypointSmoother, ObjectConfirmer, PostureSmoother,
    OBJECT_MIN_CONFIDENCE, TrackAdmission, TrackStitcher, clothing_colours,
    anchor_candidates, head_anchor_height, hip_anchor_height, classify_gestures, classify_posture, seated_on_chair, object_colour, estimate_orientation, hand_object_scores,
)
from cctv_twin_identity import FaceIdentityTracker  # noqa: E402
from cctv_twin_detail import DetailStills, scale_box, snapshot_url  # noqa: E402
from cctv_twin_stream import MjpegReader  # noqa: E402

POSE_CROP_PADDING = 0.15


def box_overlap(a, b):
    """Intersection over the smaller box: 1.0 when one box sits inside the other."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min(max(1.0, (a[2] - a[0]) * (a[3] - a[1])), max(1.0, (b[2] - b[0]) * (b[3] - b[1])))
    return ix * iy / smaller
# COCO classes the person model already knows, for room and hand objects.
# Chairs are published so the twin can draw the layout chairs where the camera
# sees them (chairs roll); a handbag on a sub-stream often reads as "suitcase".
COCO_OBJECTS = {24: "BACKPACK", 26: "HANDBAG", 28: "HANDBAG", 39: "BOTTLE", 41: "CUP", 56: "CHAIR",
                62: "MONITOR", 63: "LAPTOP", 64: "MOUSE", 66: "KEYBOARD", 67: "PHONE", 73: "NOTEBOOK"}


class BackgroundIdentity:
    """FaceIdentityTracker.update in a background thread: at most one scan in
    flight, on the frame it was given; the newest finished result is read with
    current(). onnxruntime releases the GIL, so tracking keeps its frame rate."""

    def __init__(self, tracker):
        self.tracker, self.lock = tracker, threading.Lock()
        self.busy, self.result, self.ms = False, {}, 0.0

    def submit(self, frame, boxes, now):
        with self.lock:
            if self.busy:
                return False
            self.busy = True

        def run():
            started = time.perf_counter()
            try:
                result = self.tracker.update(frame, boxes, now=now)
            except Exception as error:  # a failed scan keeps the last result
                print(f"\nFace inference failed for this frame: {error}", file=sys.stderr)
                result = None
            with self.lock:
                if result is not None:
                    self.result = result
                self.ms = (time.perf_counter() - started) * 1000.0
                self.busy = False

        threading.Thread(target=run, name="face-identity", daemon=True).start()
        return True

    def current(self):
        with self.lock:
            return dict(self.result)


def merged_objects(primary, secondary, iou=0.3):
    """Confirmed objects of both confirmers; a secondary one overlapping a
    primary one of the same type is that object and is dropped."""
    first = primary.confirmed()
    def overlap(a, b):
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy
        return ix * iy / union if union > 0 else 0.0
    extra = [dict(obj, id=f"w-{obj['id']}") for obj in secondary.confirmed()
             if not any(o["type"] == obj["type"] and overlap(o["box"], obj["box"]) >= iou for o in first)]
    return first + extra


def drop_replaced(held, frame_serial, first_seen, overlap=0.3):
    """held: {id: (last_seen, track, box, serial)}. Drops a track not seen this
    frame whose box overlaps one seen this frame that first appeared after it
    was last seen (the same body under a new id); keeps neighbours."""
    seen_now = [(value[2], first_seen.get(key, 0.0)) for key, value in held.items() if value[3] == frame_serial]
    return {key: value for key, value in held.items()
            if value[3] == frame_serial or not any(
                box_overlap(value[2], box) >= overlap and since > value[0] for box, since in seen_now)}


def drop_held_phones(objects, held_boxes, overlap=0.3):
    """A phone someone is holding (the hand scan's) is not also a loose object
    on the table: live, the room scan at 1920 px caught the phone in a man's
    hands too, which would draw it twice."""
    def covered(box):
        return any(box_overlap(box, held) >= overlap for held in held_boxes)
    return [obj for obj in objects if not (obj["type"] == "PHONE" and covered(obj["box"]))]


def floor_usable(kind, box, frame_height):
    """A chair's box bottom is its base on the floor, unless the frame cuts it off."""
    return kind != "CHAIR" or box[3] < frame_height - 3


def read_env(path):
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def arguments():
    parser = argparse.ArgumentParser(description="CCTV person feed for the factory twin")
    parser.add_argument("--camera-ref", default="nvr1:11")
    parser.add_argument("--stream-index", type=int, default=21)
    parser.add_argument("--cms-url", default="http://127.0.0.1:5050")
    parser.add_argument("--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    parser.add_argument("--model", type=Path, default=Path("/Volumes/CineframeSSD/AI_PROJECTS/PHONE_DETC/yolov8m.pt"))
    parser.add_argument("--world-model", type=Path, default=Path("/Volumes/CineframeSSD/AI_PROJECTS/PHONE_DETC/yolov8s-worldv2.pt"))
    parser.add_argument("--confidence", type=float, default=0.20)
    parser.add_argument("--fps", type=float, default=4.0, help="Maximum inference frames per second")
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--tracker-config", type=Path, default=Path(__file__).resolve().parent / "cctv_twin_botsort.yaml")
    # 3 s (owner's choice, 15 Oct): someone who gets up is let go of sooner, so
    # the twin's figure follows them (the twin's own 3 s grace still bridges a
    # sitter briefly hidden behind the table). It was 6 s: a man walking out
    # stayed frozen at his laptop for 4-6 s.
    parser.add_argument("--track-hold", type=float, default=3.0, help="Seconds to retain a temporarily occluded track")
    parser.add_argument("--world-interval", type=float, default=6.0, help="Seconds between open-vocabulary scene scans")
    parser.add_argument("--world-confidence", type=float, default=0.18)
    parser.add_argument("--world-imgsz", type=int, default=768)
    parser.add_argument("--pose-model", type=Path, default=Path("/Volumes/CineframeSSD/AI_PROJECTS/PHONE_DETC/yolov8n-pose.pt"))
    parser.add_argument("--no-pose", action="store_true", help="People-only mode: no posture or orientation evidence")
    parser.add_argument("--pose-interval", type=float, default=0.3, help="Minimum seconds between pose updates per track (the twin keyframes the body from these)")
    parser.add_argument("--pose-imgsz", type=int, default=320)
    parser.add_argument("--no-objects", action="store_true", help="Publish no room or hand objects")
    parser.add_argument("--object-interval", type=float, default=4.0, help="Seconds between COCO room-object scans (desk objects barely move)")
    # 1920 (upsampled from 1280): a cluster of clear bottles scored 0.2-0.5 at
    # 1280, so only 0-3 of 7 were ever confirmed; at 1920 5-6 of 7 stay.
    parser.add_argument("--object-imgsz", type=int, default=1920, help="Room-object scan size: cups, mice, phones and clear bottles need more than the frame")
    # 1 s: a phone in a hand, half hidden by fingers, is found in about a
    # third of frames (live: 4 of 12); one check every 2 s rarely saw it twice.
    parser.add_argument("--hand-object-interval", type=float, default=1.0, help="Seconds between phone checks on person crops")
    parser.add_argument("--admit-seconds", type=float, default=2.0,
                        help="A new track is published only after this long seen in most frames (no flickering phantoms)")
    parser.add_argument("--posture-dwell", type=float, default=3.0, help="Seconds a new posture must hold before it is published")
    # 640: a phone held at the chest scored 0.47 at 480 and 0.81 at 640 (live).
    parser.add_argument("--hand-imgsz", type=int, default=640)
    parser.add_argument("--quality", choices=("original", "standard"), default="original",
                        help="original: the camera's main stream (through cctv.grav.in at most 1280x720, 4 fps; holds one "
                             "NVR connection while running, ~3-6.5 Mbps); standard: the sub-stream (NVR1: 352x288 shown as 640x360)")
    parser.add_argument("--detail-interval", type=float, default=15.0,
                        help="Seconds between full-detail (Original) stills for room objects; 0 = scan the stream frame")
    parser.add_argument("--detail-imgsz", type=int, default=1280)
    parser.add_argument("--no-publish", action="store_true",
                        help="Capture only: never post to the CMS (no frames, no lease, no final frame)")
    parser.add_argument("--dump", type=Path, default=None, help="Append every payload as a JSON line to this file")
    parser.add_argument("--max-seconds", type=float, default=0.0, help="Stop after this long (0 = run until stopped)")
    parser.add_argument("--enable-face-identity", action="store_true", help="Attach repeated, trusted face matches")
    parser.add_argument("--face-db", type=Path, default=Path("/Volumes/CineframeSSD/AI_PROJECTS/PHONE_DETC/FACE_TRACKER/face_db.pkl"))
    parser.add_argument("--identity-interval", type=float, default=3.0, help="Seconds between face scans (a name does not change between them)")
    parser.add_argument("--identity-hold", type=float, default=5.0, help="Seconds to retain a confirmed name on the same track")
    return parser.parse_args()


def box_iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = max(1.0, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)
    return inter / union


def pose_crop(frame, box):
    """Crop a person box with padding, clamped to the frame. Returns (crop, x0, y0)."""
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    pad_x = (x2 - x1) * POSE_CROP_PADDING
    pad_y = (y2 - y1) * POSE_CROP_PADDING
    cx1 = int(max(0, min(width - 1, x1 - pad_x)))
    cy1 = int(max(0, min(height - 1, y1 - pad_y)))
    cx2 = int(max(cx1 + 1, min(width, x2 + pad_x)))
    cy2 = int(max(cy1 + 1, min(height, y2 + pad_y)))
    return frame[cy1:cy2, cx1:cx2], cx1, cy1


def run_pose(pose_model, frame, requests_by_track, imgsz):
    """One batched pose predict over person crops.

    requests_by_track: {track_id: box}. Returns {track_id: (keypoints, confs)}
    in frame coordinates, for crops where a pose detection matches the
    crop's own person box.
    """
    if not requests_by_track:
        return {}
    track_ids = list(requests_by_track)
    crops = []
    offsets = []
    for track_id in track_ids:
        crop, x0, y0 = pose_crop(frame, requests_by_track[track_id])
        crops.append(crop)
        offsets.append((x0, y0))
    results = pose_model.predict(crops, imgsz=imgsz, conf=0.25, verbose=False)
    poses = {}
    for track_id, result, (x0, y0) in zip(track_ids, results, offsets):
        if result.keypoints is None or result.boxes is None or len(result.boxes) == 0:
            continue
        x1, y1, x2, y2 = requests_by_track[track_id]
        target = (x1 - x0, y1 - y0, x2 - x0, y2 - y0)
        candidates = result.boxes.xyxy.cpu().tolist()
        overlaps = [box_iou(target, candidate) for candidate in candidates]
        best_index = max(range(len(overlaps)), key=overlaps.__getitem__)
        if overlaps[best_index] < 0.3:
            continue
        xy = result.keypoints.xy[best_index].cpu().tolist()
        if result.keypoints.conf is not None:
            confs = [float(value) for value in result.keypoints.conf[best_index].cpu().tolist()]
        else:
            confs = [0.0] * len(xy)
        keypoints = [(float(x) + x0, float(y) + y0) for x, y in xy]
        # Ultralytics reports undetected keypoints at (0, 0) in the crop.
        confs = [0.0 if raw[0] == 0 and raw[1] == 0 else conf for raw, conf in zip(xy, confs)]
        # A point on the frame's edge is the model guessing a body part out of
        # view (feet of someone cut off by the bottom): not seen.
        height, width = frame.shape[:2]
        confs = [0.0 if (x <= 2 or y <= 2 or x >= width - 3 or y >= height - 3) else conf
                 for (x, y), conf in zip(keypoints, confs)]
        poses[track_id] = (keypoints, confs)
    return poses


def scan_person_crops(model, frame, boxes, imgsz):
    """Phones near people: the person model on upscaled person crops, where a
    hand-held phone has two to three times the pixels it has in the full
    frame. Returns [("PHONE", confidence, box in frame pixels)]."""
    crops, offsets = [], []
    for box in boxes:
        crop, x0, y0 = pose_crop(frame, box)
        crops.append(crop)
        offsets.append((x0, y0))
    found = []
    for result, (x0, y0) in zip(model.predict(crops, classes=[67], conf=0.25, imgsz=imgsz, verbose=False), offsets):
        if result.boxes is None:
            continue
        for b, c in zip(result.boxes.xyxy.cpu().tolist(), result.boxes.conf.cpu().tolist()):
            found.append(("PHONE", float(c), (b[0] + x0, b[1] + y0, b[2] + x0, b[3] + y0)))
    return found


def main():
    args = arguments()
    env = {**read_env(args.env_file), **os.environ}
    cctv_url = env.get("CCTV_APP_URL", "").rstrip("/")
    cctv_key = env.get("CCTV_KEY", "")
    service_key = env.get("CCTV_SERVICE_KEY", "")
    if not cctv_url or not cctv_key:
        raise SystemExit("CCTV_APP_URL and CCTV_KEY are required in the backend environment.")
    if not args.model.exists():
        raise SystemExit(f"Person model not found: {args.model}")
    if not args.world_model.exists():
        raise SystemExit(f"YOLO-World model not found: {args.world_model}")
    if not args.tracker_config.exists():
        raise SystemExit(f"Tracker config not found: {args.tracker_config}")

    stream_url = f"{cctv_url}/stream/{args.stream_index}?key={urllib.parse.quote(cctv_key)}"
    if args.quality == "original":
        # The CCTV app serves Original only to a fullscreen viewer (prio=full);
        # fps caps what it sends to the rate this worker processes.
        stream_url += f"&quality=original&prio=full&fps={max(1, int(round(args.fps)))}"
    endpoint = args.cms_url.rstrip("/") + "/api/cctv/twin/internal/observations"
    headers = {"Content-Type": "application/json"}
    if service_key:
        headers["X-CCTV-Service-Key"] = service_key

    print(f"Loading person tracker: {args.model.name} + {args.tracker_config.name}")
    model = YOLO(str(args.model))
    # A separate instance for object and phone detection. model.track() attaches
    # the person tracker to its model's predictor, and every later predict() on
    # that same instance is fed through it: object scans came back as the few
    # boxes the tracker kept (1 of 22 on a live frame), and bottles and laptops
    # polluted the person tracks. People are tracked with `model` only.
    object_model = YOLO(str(args.model))
    identity_tracker = None
    if args.enable_face_identity:
        if not args.face_db.exists():
            raise SystemExit(f"Face gallery not found: {args.face_db}")
        try:
            print(f"Loading read-only trusted face gallery: {args.face_db}")
            identity_tracker = FaceIdentityTracker(args.face_db, hold_seconds=args.identity_hold)
            print(f"Face identity enabled for {len(identity_tracker.gallery)} trusted employees.")
        except Exception as error:
            raise SystemExit(f"Face identity could not be started: {error}") from error
    else:
        print("Face identity disabled; tracks remain anonymous.")
    pose_model = None
    if args.no_pose:
        print("Pose disabled (--no-pose): people-only mode, posture UNKNOWN.")
    elif not args.pose_model.exists():
        print(f"Pose model not found ({args.pose_model}); people-only mode, posture UNKNOWN.", file=sys.stderr)
    else:
        try:
            print(f"Loading pose layer: {args.pose_model.name}")
            pose_model = YOLO(str(args.pose_model))
        except Exception as error:  # a broken pose model must not stop occupancy
            print(f"Pose model failed to load ({error}); people-only mode, posture UNKNOWN.", file=sys.stderr)
            pose_model = None
    pose_enabled = pose_model is not None
    smoother = PostureSmoother(dwell_s=max(0.0, args.posture_dwell))
    admission = TrackAdmission(admit_s=max(0.0, args.admit_seconds))
    stabilizer = AnchorStabilizer()
    anchor_hold = AnchorModeHold(hold_s=1.0)
    keypoint_smoother = KeypointSmoother()
    # Shirt / trouser colour per track (colour only, no image), for the twin's figures.
    appearance = AppearanceSmoother()
    gesture_smoother = EvidenceSmoother()
    interaction_smoother = EvidenceSmoother(on=0.6, off=0.3, confirmations=2)
    # Objects are shown only once confirmed across repeated scans (3 of the
    # last 5): single detections on this feed are too often wrong.
    room_objects = ObjectConfirmer(need=3, window=5, forget_s=30.0)
    # Furniture and desk objects: a long memory, fed by both detectors (ids
    # stay; a person in front of a chair or a cup does not erase it).
    chair_map = StaticObjectMap(keep_s=STATIC_KEEP_S, min_conf={**OBJECT_MIN_CONFIDENCE, "CHAIR": 0.3})
    # YOLO-World scans are 4x rarer than COCO's; sharing COCO's 3-of-5 window
    # they could never confirm anything only YOLO-World sees (the leather bag).
    world_objects = ObjectConfirmer(need=2, window=3, forget_s=max(40.0, 4 * args.world_interval))
    # On full-detail stills (one every --detail-interval s) a sighting is far more
    # trustworthy than on the stretched sub-stream, and rarer: 2 of the last 3.
    detail_objects = ObjectConfirmer(need=2, window=3, forget_s=max(45.0, 3.5 * args.detail_interval))
    # 2 of the last 6 checks: a held phone flickers in and out of detection
    # (live: a man reading his phone was never confirmed at 3 of 5). Kept 6 s,
    # so one put down stops counting as held soon after.
    hand_objects = ObjectConfirmer(need=2, window=6, forget_s=6.0, keep_s=6.0, thresholds={"PHONE": 0.35})
    last_object_scan = -1e9
    last_hand_scan = -1e9
    object_ms = 0.0
    # track_id -> {"t": monotonic time of last pose, "box": box at that time,
    #              "keypoints", "confs", "visibility", "orientation"}
    pose_state = {}
    identity_by_track = {}
    background_identity = BackgroundIdentity(identity_tracker) if identity_tracker is not None else None
    last_identity_inference = -1e9
    identity_ms = 0.0
    world_prompts = [
        "office chair", "conference table", "laptop computer", "desktop monitor",
        "water bottle", "coffee cup", "computer keyboard", "mobile phone",
        "paper document", "backpack", "handbag", "briefcase", "waste bin",
    ]
    world_types = {
        "office chair": "CHAIR", "conference table": "TABLE",
        "laptop computer": "LAPTOP", "desktop monitor": "MONITOR",
        "water bottle": "BOTTLE", "coffee cup": "CUP",
        "computer keyboard": "KEYBOARD", "mobile phone": "PHONE",
        "paper document": "DOCUMENT", "backpack": "BACKPACK", "handbag": "HANDBAG", "briefcase": "HANDBAG", "waste bin": "BIN",
    }
    print(f"Loading scene discovery layer: {args.world_model.name}")
    world_model = YOLOWorld(str(args.world_model))
    world_model.set_classes(world_prompts)
    # Not cv2.VideoCapture: it would rescale every frame to the first one's size
    # (the 640x360 stand-in that precedes Original). See cctv_twin_stream.
    cap = MjpegReader(stream_url).start()
    if not cap.isOpened():
        raise SystemExit("Conference Room stream could not be opened.")
    stills = None
    if not args.no_objects and args.detail_interval > 0 and args.quality != "original":
        stills = DetailStills(snapshot_url(cctv_url, args.stream_index, cctv_key), interval=args.detail_interval).start()
        print(f"Room objects from a full-detail still every {args.detail_interval:g} s (stream-frame scans until the first arrives)")
    detail_reported = None

    running = True
    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    session_ref = f"person-worker:{args.camera_ref}:{int(time.time())}"
    interval = 1.0 / max(0.2, args.fps)
    last_inference = 0.0
    last_world_inference = -1e9
    failures = 0
    held_tracks = {}
    first_seen = {}  # stable id -> when it first appeared
    frame_serial = 0
    frame_shape = None
    # Tracker id switches on the same body keep one published id.
    stitcher = TrackStitcher(hold_s=max(0.0, args.track_hold))
    last_publish = None
    fps_measured = None
    pose_ms = 0.0
    world_ms = 0.0
    print(f"{'Capturing (not publishing)' if args.no_publish else 'Publishing'} {args.camera_ref}"
          f"{'' if args.no_publish else f' to {endpoint}'} (Ctrl+C to stop)")
    started_at = time.monotonic()
    try:
        while running:
            if args.max_seconds > 0 and time.monotonic() - started_at >= args.max_seconds:
                break
            ok, frame = cap.read()
            if not ok or frame is None:
                failures += 1
                if failures > 20:
                    cap.release()
                    time.sleep(1)
                    cap = MjpegReader(stream_url).start()
                    failures = 0
                continue
            failures = 0
            if frame.shape[:2] != frame_shape:
                frame_shape = frame.shape[:2]
                print(f"\nStream frames: {frame_shape[1]}x{frame_shape[0]} ({args.quality} requested, frame state {cap.state})")
            now = time.monotonic()
            if now - last_inference < interval:
                continue
            last_inference = now
            detect_started = time.perf_counter()
            result = model.track(frame, classes=[0], conf=args.confidence, persist=True,
                                 tracker=str(args.tracker_config), verbose=False, imgsz=args.imgsz)[0]
            detect_ms = (time.perf_counter() - detect_started) * 1000.0
            tracks = []
            frame_serial += 1
            scene_objects = []
            boxes = result.boxes
            if boxes is not None:
                ids = boxes.id
                candidates = []
                for index, xyxy in enumerate(boxes.xyxy.cpu().tolist()):
                    confidence = float(boxes.conf[index]) if boxes.conf is not None else 0.0
                    candidates.append((confidence, index, xyxy))

                # At the lower threshold needed for distant/occluded CCTV
                # people, YOLO can emit two near-identical boxes for one body.
                # Keep the strongest spatially distinct boxes so the twin count
                # is stable without suppressing a genuinely separate person.
                distinct = []
                for confidence, index, xyxy in sorted(candidates, reverse=True):
                    x1, y1, x2, y2 = xyxy
                    area = max(1.0, (x2 - x1) * (y2 - y1))
                    duplicate = False
                    for _, _, kept in distinct:
                        kx1, ky1, kx2, ky2 = kept
                        ix = max(0.0, min(x2, kx2) - max(x1, kx1))
                        iy = max(0.0, min(y2, ky2) - max(y1, ky1))
                        inter = ix * iy
                        kept_area = max(1.0, (kx2 - kx1) * (ky2 - ky1))
                        union = area + kept_area - inter
                        if inter / max(1.0, union) >= 0.38 or inter / min(area, kept_area) >= 0.72:
                            duplicate = True
                            break
                    if not duplicate:
                        distinct.append((confidence, index, xyxy))

                ordered = sorted(distinct, key=lambda item: item[1])
                pose_now = time.monotonic()
                stable = stitcher.resolve({str(int(ids[index])): xyxy for _, index, xyxy in ordered}, pose_now) \
                    if ids is not None else {}
                sid = lambda index: stable[str(int(ids[index]))]  # noqa: E731
                if identity_tracker is not None and ids is not None \
                        and pose_now - last_identity_inference >= max(0.25, args.identity_interval):
                    # Face matching (~0.4 s on CPU) runs beside tracking, on the
                    # newest frame, one scan at a time; results land when ready.
                    if background_identity.submit(frame, {sid(index): xyxy for _, index, xyxy in ordered}, pose_now):
                        last_identity_inference = pose_now
                if identity_tracker is not None:
                    identity_by_track = background_identity.current()
                    identity_ms = background_identity.ms
                if pose_enabled and ids is not None:
                    due = {}
                    for _, index, xyxy in ordered:
                        key = sid(index)
                        if pose_now - pose_state.get(key, {}).get("t", -1e9) >= max(0.0, args.pose_interval):
                            due[key] = xyxy
                    if due:
                        pose_started = time.perf_counter()
                        try:
                            poses = run_pose(pose_model, frame, due, args.pose_imgsz)
                        except Exception as error:
                            print(f"\nPose inference failed for this frame: {error}", file=sys.stderr)
                            poses = {}
                        pose_ms = (time.perf_counter() - pose_started) * 1000.0
                        for key, xyxy in due.items():
                            # "t" is the last attempt (rate limit); "pose_t"
                            # the last matched pose (evidence age).
                            entry = dict(pose_state.get(key) or {
                                "pose_t": -1e9, "box": xyxy, "keypoints": None, "confs": None,
                                "visibility": None, "orientation": (None, 0.0),
                            })
                            entry["t"] = pose_now
                            if key in poses:
                                keypoints, confs = poses[key]
                                scores, visibility = classify_posture(keypoints, confs)
                                scores = seated_on_chair(scores, keypoints, confs, [
                                    o["box"] for o in chair_map.confirmed() if o["type"] == "CHAIR"])
                                smoother.update(key, scores, pose_now, keypoints, confs)
                                keypoint_smoother.update(key, keypoints, confs, xyxy, pose_now)
                                smooth = keypoint_smoother.current(key, xyxy, pose_now)
                                if smooth is not None:
                                    gesture_smoother.update(key, classify_gestures(
                                        [(x, y) for x, y, _ in smooth], [c for _, _, c in smooth]), pose_now)
                                appearance.update(key, clothing_colours(frame, keypoints, confs), pose_now)
                                entry.update(pose_t=pose_now, box=xyxy, keypoints=keypoints, confs=confs,
                                             visibility=visibility,
                                             orientation=estimate_orientation(keypoints, confs))
                            pose_state[key] = entry

                if not args.no_objects and ids is not None and ordered \
                        and pose_now - last_hand_scan >= max(0.25, args.hand_object_interval):
                    last_hand_scan = pose_now
                    hand_started = time.perf_counter()
                    try:
                        phones = scan_person_crops(object_model, frame, [xyxy for _, _, xyxy in ordered], args.hand_imgsz)
                    except Exception as error:
                        print(f"\nPhone check failed for this frame: {error}", file=sys.stderr)
                        phones = []
                    hand_objects.update(phones, pose_now)
                    object_ms = (time.perf_counter() - hand_started) * 1000.0
                    confirmed_phones = hand_objects.confirmed()
                    for _, index, xyxy in ordered:
                        key = sid(index)
                        smooth = keypoint_smoother.current(key, xyxy, pose_now)
                        if smooth is None:
                            continue
                        interaction_smoother.update(key, hand_object_scores(
                            [(x, y) for x, y, _ in smooth], [c for _, _, c in smooth], confirmed_phones), pose_now)

                admitted = admission.update({sid(index): confidence for confidence, index, _ in ordered}, pose_now) \
                    if ids is not None else set()
                for confidence, index, xyxy in ordered:
                    if ids is not None and sid(index) not in admitted:
                        # Not yet a person for long enough (see TrackAdmission).
                        continue
                    if ids is None:
                        # The tracker has not confirmed anyone this frame:
                        # an untracked box would appear and vanish in the
                        # twin as a phantom. Held tracks cover the gap.
                        continue
                    x1, y1, x2, y2 = xyxy
                    track_id = sid(index)
                    track = {
                        "sourceTrackId": str(track_id),
                        "footPointPx": {"x": (x1 + x2) / 2.0, "y": y2},
                        # The detector's own box, for the twin's dev view.
                        "imageBoxPx": {"x1": round(x1, 1), "y1": round(y1, 1), "x2": round(x2, 1), "y2": round(y2, 1)},
                        "trackingConfidence": confidence,
                        "anchorMode": "OCCUPANCY_PROXY",
                        "posture": "UNKNOWN",
                        "postureConfidence": 0.0,
                        "postureSource": "NONE",
                    }
                    state = pose_state.get(str(track_id)) if pose_enabled and ids is not None else None
                    if state is not None:
                        posture, posture_confidence = smoother.current(str(track_id), pose_now)
                        # Body heights follow the posture the evidence leans to
                        # while the confirmed one is still dwelling.
                        lean, lean_confidence = smoother.lean(str(track_id), pose_now)
                        evidence_fresh = pose_now - state["pose_t"] <= max(2.0, 3.0 * args.pose_interval)
                        keypoints = state["keypoints"] if evidence_fresh else None
                        if keypoints is not None and state["box"] is not xyxy:
                            # Pose from an earlier frame: follow the box's
                            # bottom-centre so the anchor tracks the person.
                            old = state["box"]
                            dx = (x1 + x2 - old[0] - old[2]) / 2.0
                            dy = y2 - old[3]
                            keypoints = [(kx + dx, ky + dy) for kx, ky in keypoints]
                        confs_now = state["confs"] if keypoints is not None else None
                        previous_mode = anchor_hold.mode(str(track_id))
                        point, anchor_mode = anchor_hold.choose(str(track_id), anchor_candidates(
                            keypoints, confs_now, xyxy, lean, frame_height=frame.shape[0]), pose_now)
                        if previous_mode is not None and anchor_mode != previous_mode:
                            stabilizer.forget(str(track_id))
                        track["footPointPx"] = {"x": point[0], "y": point[1]}
                        track["anchorMode"] = anchor_mode
                        if anchor_mode == "POSE_HEAD_ESTIMATE":
                            # Cut off by the frame bottom: the point is the head,
                            # at this height; the backend works out the floor.
                            track["anchorHeightM"] = head_anchor_height(keypoints, confs_now, lean)
                        elif anchor_mode in ("POSE_HIP_HEIGHT", "POSE_SHOULDER_HEIGHT", "BOX_TOP_HEIGHT"):
                            # Legs hidden (behind a table): the point is the
                            # shoulders (or hips) at their posture height.
                            track["anchorHeightM"] = hip_anchor_height(lean, anchor_mode)
                        if posture != "UNKNOWN":
                            track.update(posture=posture, postureConfidence=posture_confidence, postureSource="POSE")
                            if posture_confidence < 0.5:
                                # Held long past its last leg evidence: still the best guess.
                                track["postureHint"] = {"posture": posture, "confidence": max(0.4, posture_confidence)}
                        elif lean != "UNKNOWN":
                            track["postureHint"] = {"posture": lean, "confidence": lean_confidence}
                        yaw, yaw_confidence = state["orientation"] if evidence_fresh else (None, 0.0)
                        if yaw is not None:
                            track["orientation"] = {"relativeYawDeg": yaw, "confidence": yaw_confidence}
                        if evidence_fresh and state["visibility"] is not None:
                            track["keypointVisibility"] = round(state["visibility"], 3)
                        smooth = keypoint_smoother.current(str(track_id), xyxy, pose_now) if evidence_fresh else None
                        if smooth is not None:
                            # The 17 body points drive the twin's rig; the
                            # server checks them and keeps nothing.
                            track["pose2d"] = {"keypoints": [[round(x, 1), round(y, 1), round(c, 2)] for x, y, c in smooth]}
                            gestures = gesture_smoother.current(str(track_id), pose_now)
                            if gestures:
                                track["gestures"] = gestures
                            interactions = interaction_smoother.current(str(track_id), pose_now)
                            if interactions:
                                track["interactions"] = interactions
                    if ids is not None:
                        # Hold a still person still: box-edge jitter must not
                        # become movement on the floor.
                        sx, sy = stabilizer.update(str(track_id), (track["footPointPx"]["x"], track["footPointPx"]["y"]),
                                                   y2 - y1, time.monotonic())
                        track["footPointPx"] = {"x": sx, "y": sy}
                        identity = identity_by_track.get(str(track_id))
                        if identity is not None:
                            track["identity"] = identity
                        colours = appearance.current(str(track_id), pose_now)
                        if colours is not None:
                            track["appearance"] = colours
                    held_tracks[str(track_id)] = (time.monotonic(), track, xyxy, frame_serial)
                    first_seen.setdefault(str(track_id), time.monotonic())

            detail = stills.take() if stills is not None else None
            if detail is not None:
                # Room objects on the full-detail still, boxes mapped back to
                # this stream's pixels (same camera view, other resolution).
                jpeg, size, _ = detail
                still = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
                if still is not None:
                    scan_started = time.perf_counter()
                    stream_size = (int(frame.shape[1]), int(frame.shape[0]))
                    still_size = (int(still.shape[1]), int(still.shape[0]))
                    found = []
                    coco = object_model.predict(still, classes=list(COCO_OBJECTS), conf=0.2, imgsz=args.detail_imgsz, verbose=False)[0]
                    if coco.boxes is not None:
                        found += [(COCO_OBJECTS[int(k)], float(c), scale_box(b, still_size, stream_size))
                                  for b, c, k in zip(coco.boxes.xyxy.cpu().tolist(), coco.boxes.conf.cpu().tolist(),
                                                     coco.boxes.cls.cpu().tolist())]
                    world_result = world_model.predict(still, conf=args.world_confidence, imgsz=args.detail_imgsz, verbose=False)[0]
                    if world_result.boxes is not None:
                        found += [(world_types.get(str(world_result.names[int(k)]).lower()), float(c), scale_box(b, still_size, stream_size))
                                  for b, c, k in zip(world_result.boxes.xyxy.cpu().tolist(), world_result.boxes.conf.cpu().tolist(),
                                                     world_result.boxes.cls.cpu().tolist())
                                  if world_types.get(str(world_result.names[int(k)]).lower())]
                    detail_objects.update([d for d in found if floor_usable(d[0], d[2], frame.shape[0])], now)
                    world_ms = (time.perf_counter() - scan_started) * 1000.0
            detail_on = stills is not None and stills.active(now)
            if stills is not None and detail_on != detail_reported:
                detail_reported = detail_on
                print(f"\nRoom objects: {'full-detail stills' if detail_on else 'stream frames'}"
                      f"{'' if detail_on or not stills.last_error else f' ({stills.last_error})'}")
            if not args.no_objects and not detail_on and now - last_object_scan >= max(0.5, args.object_interval):
                last_object_scan = now
                scan_started = time.perf_counter()
                coco = object_model.predict(frame, classes=list(COCO_OBJECTS), conf=0.2, imgsz=args.object_imgsz, verbose=False)[0]
                found_coco = [
                    (COCO_OBJECTS[int(k)], float(c), tuple(b))
                    for b, c, k in zip(coco.boxes.xyxy.cpu().tolist(), coco.boxes.conf.cpu().tolist(), coco.boxes.cls.cpu().tolist())
                    if floor_usable(COCO_OBJECTS[int(k)], b, frame.shape[0])
                ] if coco.boxes is not None else []
                chair_map.update(found_coco, now)
                world_ms = (time.perf_counter() - scan_started) * 1000.0
            if not args.no_objects and not detail_on and now - last_world_inference >= max(2.0, args.world_interval):
                last_world_inference = now
                world_started = time.perf_counter()
                world_result = world_model.predict(
                    frame, conf=args.world_confidence, imgsz=args.world_imgsz, verbose=False,
                )[0]
                world_ms = (time.perf_counter() - world_started) * 1000.0
                if world_result.boxes is not None:
                    # YOLO-World is a second, independent vote into the same
                    # confirmer; it never publishes a detection on its own.
                    found_world = [
                        (world_types.get(str(world_result.names[int(k)]).lower()), float(c), tuple(b))
                        for b, c, k in zip(world_result.boxes.xyxy.cpu().tolist(), world_result.boxes.conf.cpu().tolist(),
                                           world_result.boxes.cls.cpu().tolist())
                        if world_types.get(str(world_result.names[int(k)]).lower())
                        and floor_usable(world_types.get(str(world_result.names[int(k)]).lower()), b, frame.shape[0])
                    ]
                    chair_map.update(found_world, now)
            # Brief detector misses are common when a seated person leans behind
            # the table. Keep the last camera-local track for a bounded window;
            # the CMS TTL still removes everything if this worker stops.
            cutoff = time.monotonic() - max(0.0, args.track_hold)
            held_tracks = {key: value for key, value in held_tracks.items() if value[0] >= cutoff}
            # A held (not seen this frame) track that overlaps someone seen this
            # frame who first appeared after it went missing is that person
            # under a new id the stitcher could not join: drop the held copy
            # rather than show the same body twice. Someone who was there
            # alongside it is a neighbour (live: two men side by side at the
            # table; each blink of one dropped him, so he vanished and came back).
            held_tracks = drop_replaced(held_tracks, frame_serial, first_seen)
            first_seen = {key: value for key, value in first_seen.items() if key in held_tracks}
            tracks = [value[1] for value in held_tracks.values()]
            scene_objects = [] if args.no_objects else [
                {
                    "sourceObjectId": obj["id"],
                    "objectType": obj["type"],
                    "anchorPointPx": {"x": (obj["box"][0] + obj["box"][2]) / 2.0, "y": obj["box"][3]},
                    "imageBoxPx": {"x1": obj["box"][0], "y1": obj["box"][1], "x2": obj["box"][2], "y2": obj["box"][3]},
                    "confidence": obj["confidence"],
                    "confirmations": obj["confirmations"],
                    "source": "DETECTOR_CONFIRMED",
                    **({"colour": object_colour(frame, obj["box"])} if obj["type"] in ("BACKPACK", "HANDBAG") else {}),
                }
                for obj in drop_held_phones(detail_objects.confirmed() if detail_on else chair_map.confirmed(),
                                            [held["box"] for held in hand_objects.confirmed()])
            ]
            live_ids = set(held_tracks)
            pose_state = {key: value for key, value in pose_state.items() if key in live_ids}
            smoother.prune(time.monotonic(), keep_ids=live_ids)
            keypoint_smoother.prune(time.monotonic(), keep_ids=live_ids)
            gesture_smoother.prune(time.monotonic(), keep_ids=live_ids)
            interaction_smoother.prune(time.monotonic(), keep_ids=live_ids)
            stabilizer.prune(time.monotonic(), keep_ids=live_ids)
            anchor_hold.prune(live_ids)
            published_at = time.perf_counter()
            if last_publish is not None:
                instant = 1.0 / max(1e-3, published_at - last_publish)
                fps_measured = instant if fps_measured is None else 0.7 * fps_measured + 0.3 * instant
            last_publish = published_at
            pipeline = {
                "personModel": args.model.name,
                "tracker": args.tracker_config.name,
                "worldModel": args.world_model.name,
                "poseEnabled": pose_enabled,
                "peopleOnly": not pose_enabled,
                "worldEnabled": not args.no_objects,
                "objectsEnabled": not args.no_objects,
                "detectMs": round(detect_ms, 1),
                "worldMs": round(world_ms, 1),
                "objectMs": round(object_ms, 1),
                "identityEnabled": identity_tracker is not None,
            }
            if identity_tracker is not None:
                pipeline["identityModel"] = "buffalo_l"
                pipeline["identityMs"] = round(identity_ms, 1)
            if pose_enabled:
                pipeline["poseModel"] = args.pose_model.name
                pipeline["poseMs"] = round(pose_ms, 1)
            if fps_measured is not None:
                pipeline["fps"] = round(fps_measured, 1)
            payload = {
                "cameraRef": args.camera_ref,
                "sessionRef": session_ref,
                "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "frameSize": {"width": int(frame.shape[1]), "height": int(frame.shape[0])},
                "tracks": tracks,
                "objects": scene_objects,
                "pipeline": pipeline,
            }
            if args.dump is not None:
                with args.dump.open("a") as dump:
                    dump.write(json.dumps({"t": time.time(), "payload": payload}) + "\n")
            if args.no_publish:
                continue
            try:
                response = requests.post(endpoint, json=payload, headers=headers, timeout=3)
                if response.status_code == 409:
                    try:
                        code = response.json().get("code")
                    except ValueError:
                        code = None
                    if code == "FEED_SESSION_CONFLICT":
                        print(f"\nAnother worker holds this camera's feed ({args.camera_ref}); retrying in 2 s.",
                              file=sys.stderr)
                        time.sleep(2)
                        continue
                response.raise_for_status()
                body = response.json()
                accepted = body.get("accepted", 0)
                reasons = sorted({item.get("reasonCode", "") for item in body.get("rejected", []) if item.get("reasonCode")})
                reason_text = ",".join(reasons) if reasons else "-"
                track_ids_text = ",".join(str(item["sourceTrackId"]) for item in tracks)
                postures = "".join(str(item.get("posture", "UNKNOWN"))[0] for item in tracks) or "-"
                print(f"\rpeople={len(tracks):2d} mapped={accepted:2d} objects={body.get('acceptedObjects', 0):2d} ids={track_ids_text:14.14s} posture={postures:8.8s} pose={'on' if pose_enabled else 'off'} rejected={reason_text:20.20s}", end="", flush=True)
            except requests.RequestException as error:
                print(f"\nCMS observation publish failed: {error}", file=sys.stderr)
                time.sleep(1)
    finally:
        cap.release()
        # A final frame releases this session's feed lease and clears the
        # camera immediately, so a replacement worker can start at once.
        # A capture-only run holds no lease and must not clear anyone's feed.
        try:
            if args.no_publish:
                raise requests.RequestException("capture only")
            requests.post(endpoint, json={"cameraRef": args.camera_ref, "sessionRef": session_ref,
                          "frameSize": {"width": 1, "height": 1}, "tracks": [], "final": True},
                          headers=headers, timeout=2)
        except requests.RequestException:
            pass
        print("\nStopped.")


if __name__ == "__main__":
    main()
