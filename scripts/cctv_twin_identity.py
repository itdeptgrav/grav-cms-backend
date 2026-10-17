"""Read-only, face-confirmed identity adapter for the CCTV twin.

The gallery belongs to PHONE_DETC. This module never enrols a person and never
writes the gallery. Body appearance may stabilize a tracker ID, but only a
direct face match can publish a name.
"""

from datetime import datetime, timezone
import pickle
import time

import numpy as np


FACE_ACCEPT_DISTANCE = 0.38
FACE_MIN_MARGIN = 0.06
MIN_FACE_SIZE = 50
MIN_DETECTION_SCORE = 0.50
MAX_ABS_YAW = 50


def _normalise(vector):
    array = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(array))
    return array / max(norm, 1e-8)


def load_trusted_gallery(path):
    """Load only explicitly READY/trusted employees from PHONE_DETC."""
    with open(path, "rb") as handle:
        data = pickle.load(handle)  # trusted local application data
    people = data.get("persons", {}) if isinstance(data, dict) else {}
    registered = data.get("registered", {}) if isinstance(data, dict) else {}
    gallery = {}
    for name, embeddings in people.items():
        metadata = registered.get(name, {}) if isinstance(registered, dict) else {}
        if metadata.get("trusted_for_live") is not True or metadata.get("readiness") != "READY":
            continue
        clean = [_normalise(item) for item in embeddings if np.asarray(item).size]
        if clean:
            gallery[str(name)] = clean
    return gallery


def match_embedding(embedding, gallery, accept_distance=FACE_ACCEPT_DISTANCE, min_margin=FACE_MIN_MARGIN):
    """Return a margin-checked nearest-person match, or None."""
    probe = _normalise(embedding)
    ranked = []
    for name, references in gallery.items():
        distance = min(1.0 - float(np.dot(probe, reference)) for reference in references)
        ranked.append((distance, name))
    if not ranked:
        return None
    ranked.sort()
    best_distance, best_name = ranked[0]
    second_distance = ranked[1][0] if len(ranked) > 1 else None
    margin = (second_distance - best_distance) if second_distance is not None else 1.0
    if best_distance > accept_distance or margin < min_margin:
        return None
    confidence = max(0.0, min(1.0, 1.0 - best_distance))
    return {"name": best_name, "distance": best_distance, "margin": margin, "confidence": confidence}


def _quality_face(face):
    x1, y1, x2, y2 = [float(value) for value in face.bbox]
    if x2 - x1 < MIN_FACE_SIZE or y2 - y1 < MIN_FACE_SIZE:
        return False
    if float(getattr(face, "det_score", 0.0)) < MIN_DETECTION_SCORE:
        return False
    pose = getattr(face, "pose", None)
    if pose is not None and len(pose) > 1 and abs(float(pose[1])) > MAX_ABS_YAW:
        return False
    return True


def _track_for_face(face_box, person_boxes):
    """Assign a face to the smallest person box whose upper body contains it."""
    fx1, fy1, fx2, fy2 = [float(value) for value in face_box]
    cx, cy = (fx1 + fx2) / 2.0, (fy1 + fy2) / 2.0
    candidates = []
    for track_id, box in person_boxes.items():
        x1, y1, x2, y2 = [float(value) for value in box]
        if x1 <= cx <= x2 and y1 <= cy <= y1 + 0.68 * (y2 - y1):
            candidates.append(((x2 - x1) * (y2 - y1), str(track_id)))
    return min(candidates)[1] if candidates else None


class FaceIdentityTracker:
    """Two-hit face confirmation with a short, same-track display hold."""

    def __init__(self, gallery_path, analyzer=None, required_hits=2, hold_seconds=5.0):
        self.gallery = load_trusted_gallery(gallery_path)
        if not self.gallery:
            raise ValueError("The trusted face gallery is empty.")
        if analyzer is None:
            from insightface.app import FaceAnalysis
            analyzer = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
            analyzer.prepare(ctx_id=-1, det_size=(640, 640))
        self.analyzer = analyzer
        self.required_hits = max(2, int(required_hits))
        self.hold_seconds = max(0.0, float(hold_seconds))
        self.state = {}

    def update(self, frame, person_boxes, now=None):
        now = time.monotonic() if now is None else float(now)
        seen_matches = {}
        for face in self.analyzer.get(frame):
            if not _quality_face(face):
                continue
            track_id = _track_for_face(face.bbox, person_boxes)
            embedding = getattr(face, "normed_embedding", None)
            if embedding is None:
                embedding = getattr(face, "embedding", None)
            if track_id is None or embedding is None:
                continue
            match = match_embedding(embedding, self.gallery)
            if match is None:
                continue
            current = seen_matches.get(track_id)
            if current is None or match["distance"] < current["distance"]:
                seen_matches[track_id] = match

        # One trusted name cannot belong to two bodies in the same frame.
        best_by_name = {}
        for track_id, match in seen_matches.items():
            current = best_by_name.get(match["name"])
            if current is None or match["distance"] < current[1]["distance"]:
                best_by_name[match["name"]] = (track_id, match)
        seen_matches = {track_id: match for track_id, match in best_by_name.values()}

        for track_id, match in seen_matches.items():
            old = self.state.get(track_id, {})
            if old.get("candidate") == match["name"] and now - old.get("candidateAt", -1e9) <= 8.0:
                hits = old.get("hits", 0) + 1
            else:
                hits = 1
            entry = {
                "candidate": match["name"], "candidateAt": now, "hits": hits,
                "distance": match["distance"], "margin": match["margin"],
                "confidence": match["confidence"],
            }
            if hits >= self.required_hits:
                entry.update(confirmed=match["name"], confirmedAt=now)
            elif old.get("confirmed") == match["name"]:
                entry.update(confirmed=old["confirmed"], confirmedAt=now)
            self.state[track_id] = entry

        live_ids = {str(value) for value in person_boxes}
        self.state = {
            track_id: entry for track_id, entry in self.state.items()
            if track_id in live_ids and now - entry.get("candidateAt", -1e9) <= max(8.0, self.hold_seconds)
        }
        output = {}
        matched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        for track_id, entry in self.state.items():
            if not entry.get("confirmed") or now - entry.get("confirmedAt", -1e9) > self.hold_seconds:
                continue
            output[track_id] = {
                "status": "CONFIRMED_FACE",
                "displayName": entry["confirmed"],
                "confidence": round(float(entry.get("confidence", 0.0)), 3),
                "distance": round(float(entry.get("distance", 1.0)), 3),
                "margin": round(float(entry.get("margin", 0.0)), 3),
                "source": "PHONE_DETC_GALLERY",
                "matchedAt": matched_at,
            }
        return output

