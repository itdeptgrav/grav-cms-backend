#!/usr/bin/env python3
"""
face_biometric.py — face-only punch-in prototype.

A punch-in machine is a much smaller problem than a CCTV tracker, and most
of what makes the tracker hard does not exist here. One camera. One person,
standing still, looking at it, wanting to be recognised. Nobody walks out of
frame mid-identification and nobody is identified from behind.

So this file deliberately keeps ONLY the face pieces: detection, the
registration quality gate, embeddings, and the distance between them.
Person tracking, Re-ID, clothing, pose separation, pending queues,
cross-camera reasoning, physical tracklets, candidates and the whole
Other_People / Unknown_BackView folder machinery are all absent by design,
not by omission — none of them can help when a face is the only evidence
and the only thing being asked for.

It does not import cctv_face_tracker: importing it loads databases, takes a
run lock and builds models as a side effect. The few helpers worth sharing
are small and pure, so they are copied verbatim rather than reached for.

Through CHUNK 4 this reads REGISTERED_PEOPLE/, builds the in-memory gallery,
reports how usable it is, verifies a live face against it, and writes one
attendance row per punch-in — with the cooldown recovered from the log on
startup, so restarting the machine cannot let somebody punch in twice. It
creates only ATTENDANCE/, and touches neither face_db.pkl nor FACE_TRACKER.

    python face_biometric.py --check-registered
    python face_biometric.py --attendance-status
    python face_biometric.py --hr-map-status
    python face_biometric.py --camera 0 --kiosk              # the machine
    python face_biometric.py --camera 0
    python face_biometric.py --source rtsp://... | path/to/video.avi
    python face_biometric.py --camera 0 --once
    python face_biometric.py --source video.avi --no-log     # dry run
"""

import argparse
import csv
import os
import sys
import time
from collections import OrderedDict
from datetime import datetime

import cv2
import numpy as np

from insightface.app import FaceAnalysis

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Where the DATA lives, as opposed to the code.
#
# Photos, the employee mapping and the attendance log are not source: they
# outlive any particular checkout and must not sit inside one. Keeping them
# next to the script was right while this was a self-contained tool on a USB
# stick; now that the engine is owned by the backend, the two have to be
# separable.
#
# The default is deliberately "beside the script", so an existing install
# keeps working untouched. A deployment points FACE_BIOMETRIC_DATA_DIR at
# wherever it keeps state, and nothing else changes.
FACE_BIOMETRIC_ROOT = os.environ.get("FACE_BIOMETRIC_ROOT") or SCRIPT_DIR
DATA_DIR = FACE_BIOMETRIC_ROOT

# Each location is independently overridable, so a deployment can keep the
# photos on one volume and the mapping on another without moving the rest.
# Unset, they all fall back to the root, which is the layout the standalone
# install has always had.
REGISTERED_PEOPLE_DIR = (os.environ.get("FACE_BIOMETRIC_REGISTERED_DIR")
                         or os.path.join(DATA_DIR, "REGISTERED_PEOPLE"))

# Raw camera formats are excluded on purpose: cv2.imread cannot decode a
# .dng, so including them would report every one as "unreadable" and bury
# the real rejections.
REGISTERED_EXTS = (".jpg", ".jpeg", ".png", ".webp")

# ── model ────────────────────────────────────────────────────────
# The same detector and the same recogniser as the tracker. A punch-in that
# measured faces differently from the system the photos were registered
# against would need its own registration set, and the distances below
# would mean something different from the ones in the tracker's logs.
FACE_MODEL_NAME = "buffalo_l"
DETECTION_SIZE = (640, 640)

# ── registration quality (copied unchanged from the tracker) ─────
# A registered identity is permanent, so it has to be EARNED by the photo
# set. Two tiers: a core anchor is a straight, sharp, confident face and is
# what identification actually leans on; a support view is usable but
# weaker, and only broadens the gallery. Neither tier is per-employee — the
# same numbers decide for three people or fifty.
REG_CORE_MAX_YAW          = 25
REG_SUPPORT_MAX_YAW       = 45
REG_CORE_MIN_DET          = 0.70
REG_SUPPORT_MIN_DET       = 0.60
REG_CORE_MIN_FACE_SIZE    = 100
REG_SUPPORT_MIN_FACE_SIZE = 80
REG_CORE_MIN_BLUR         = 40.0   # Laplacian variance; 0 disables
REG_MIN_CORE_ANCHORS      = 3
REG_MIN_TOTAL_EMBEDS      = 4

# Laplacian variance is scale dependent — the same sharp face measures ~6 on
# a 2000px phone crop and ~385 once normalised — so every crop is resized to
# one fixed size before it is measured.
REG_BLUR_NORM_SIDE = 128

# Two employees whose galleries sit closer than this cannot be told apart by
# any threshold, so the pair is reported rather than silently accepted.
REG_MIN_SEPARATION = 0.50

# ── identification thresholds (the tracker's, unchanged) ─────────
# Two bars and a gap between them, because "not close enough to accept" and
# "far enough to call a stranger" are different claims. Between them the
# honest answer is neither, and saying so is the point: a punch-in that
# guesses in that band signs somebody else in.
FACE_ACCEPT_DIST = 0.38
FACE_REJECT_DIST = 0.55
# The best name must beat the SECOND-BEST PERSON by this much. Distance
# alone says a face resembles someone; the margin says it resembles them
# more than it resembles anybody else, which is the question being asked.
FACE_MARGIN = 0.06

# ── live capture quality gate ────────────────────────────────────
# Deliberately more forgiving than registration. A registered identity is
# permanent and must be earned; a live frame is discarded a moment later, so
# a marginal one costs nothing and refusing it costs a punch-in.
LIVE_MIN_FACE_SIZE = 50
LIVE_MIN_DET_SCORE = 0.50
LIVE_MAX_YAW       = 50

# ── stability ────────────────────────────────────────────────────
# One frame is not a decision. A single lucky frame can match, so a name has
# to hold across several frames close together in time before it counts.
# Frames, not seconds, because the count is what proves persistence; the
# window only stops a match assembling itself out of three moments minutes
# apart.
VERIFY_HITS       = 3
VERIFY_WINDOW_SEC = 2.0

# ── attendance ───────────────────────────────────────────────────
ATTENDANCE_DIR    = os.path.join(DATA_DIR, "ATTENDANCE")
ATTENDANCE_LOG    = os.path.join(ATTENDANCE_DIR, "attendance.csv")
ATTENDANCE_HEADER = ["timestamp_iso", "date", "time", "employee",
                     "distance", "source"]

# Somebody standing at the machine is recognised many times a second. The
# cooldown is what makes a punch-in an EVENT rather than a rate of frames:
# without it a person waiting for a colleague files a row per verification.
PUNCH_COOLDOWN_SEC = 30.0

# How long the result stays on screen before the machine is free again. It
# is not a security setting — the cooldown, which outlives it, is what stops
# a second row. This only decides how long the person sees their own name.
AUTO_RESET_SEC = 5.0

# ── kiosk ────────────────────────────────────────────────────────
# What the person at the machine reads. Six short states, each of which
# tells them either that the machine is working or what to do about it.
# Distances, margins and frame counts are for the operator, not for them.
WINDOW_NAME = "Face Punch In"
CAMERA_WIDTH  = 1280
CAMERA_HEIGHT = 720

KIOSK_READY   = "READY"
KIOSK_LOOK    = "LOOK AT CAMERA"
KIOSK_UNKNOWN = "UNKNOWN"

# One colour per meaning, so the screen is readable from further away than
# the text is.
KIOSK_COLOURS = {
    "PUNCHED":   (80, 200, 80),
    "VERIFIED":  (80, 200, 80),
    "MATCHING":  (200, 200, 60),
    "COOLDOWN":  (40, 170, 240),
    "UNKNOWN":   (60, 60, 220),
    "NOT":       (60, 60, 220),
    "LOOK":      (40, 170, 240),
    "READY":     (190, 190, 190),
}


# ── small pure helpers (copied, not imported) ────────────────────
def cosine_distance(a, b):
    a_n = a / (np.linalg.norm(a) + 1e-8)
    b_n = b / (np.linalg.norm(b) + 1e-8)
    return 1.0 - float(np.dot(a_n, b_n))


def l2_normalise(v):
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


def face_blur(img, face):
    """Sharpness of the face crop: low = soft or out of focus."""
    try:
        x1, y1, x2, y2 = [int(v) for v in face.bbox]
        crop = img[max(0, y1):max(1, y2), max(0, x1):max(1, x2)]
        if crop.size == 0:
            return None
        crop = cv2.resize(crop, (REG_BLUR_NORM_SIDE, REG_BLUR_NORM_SIDE),
                          interpolation=cv2.INTER_AREA)
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(g, cv2.CV_64F).var())
    except Exception:
        return None


def classify_registration_face(size, det, yaw, blur=None):
    """core_anchor / support_view / rejected, with the reason.

    Pure and name-agnostic: works the same for 3 employees or 50.
    """
    if size is None or size < REG_SUPPORT_MIN_FACE_SIZE:
        return None, (f"small({size:.0f}px)" if size is not None
                      else "no_face")
    if det is None or det < REG_SUPPORT_MIN_DET:
        return None, (f"det={det:.2f}" if det is not None else "no_det")
    if yaw is not None and abs(yaw) > REG_SUPPORT_MAX_YAW:
        return None, f"yaw={yaw:.0f}"

    core = (det >= REG_CORE_MIN_DET
            and size >= REG_CORE_MIN_FACE_SIZE
            and (yaw is None or abs(yaw) <= REG_CORE_MAX_YAW)
            and (blur is None or REG_CORE_MIN_BLUR <= 0
                 or blur >= REG_CORE_MIN_BLUR))
    return ("core_anchor" if core else "support_view"), "ok"


# ── model loading ────────────────────────────────────────────────
def build_face_app(verbose=True):
    """InsightFace buffalo_l, GPU when the runtime actually offers it."""
    try:
        import onnxruntime
        available = onnxruntime.get_available_providers()
    except Exception:
        available = []
    use_gpu = "CUDAExecutionProvider" in available
    providers = (["CUDAExecutionProvider", "CPUExecutionProvider"]
                 if use_gpu else ["CPUExecutionProvider"])
    try:
        app = FaceAnalysis(name=FACE_MODEL_NAME, providers=providers)
        app.prepare(ctx_id=0 if use_gpu else -1, det_size=DETECTION_SIZE)
    except Exception:
        app = FaceAnalysis(name=FACE_MODEL_NAME,
                           providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=DETECTION_SIZE)
        use_gpu = False
    if verbose:
        print(f"   {FACE_MODEL_NAME} ready "
              f"({'GPU' if use_gpu else 'CPU'}, det_size={DETECTION_SIZE})")
    return app


# ── registration ─────────────────────────────────────────────────
def analyse_photo(face_app, path):
    """One registration photo, measured and judged. Nothing is written."""
    rec = {"file": os.path.basename(path), "accepted": False,
           "role": "rejected", "reason": None, "size": None, "det": None,
           "yaw": None, "blur": None, "faces": 0, "embedding": None}

    img = cv2.imread(path)
    if img is None:
        rec["reason"] = "unreadable"
        return rec
    try:
        faces = face_app.get(img)
    except Exception as e:
        rec["reason"] = f"detect_error:{type(e).__name__}"
        return rec
    rec["faces"] = len(faces)
    if not faces:
        rec["reason"] = "no_face"
        return rec

    # The largest face is the subject. A registration photo with somebody
    # in the background is common; one where the background face is bigger
    # than the subject is not a registration photo.
    best = max(faces, key=lambda f: ((f.bbox[2] - f.bbox[0])
                                     * (f.bbox[3] - f.bbox[1])))
    fx1, fy1, fx2, fy2 = best.bbox
    rec["size"] = float(min(fx2 - fx1, fy2 - fy1))
    rec["det"] = float(getattr(best, "det_score", 0.0))
    if getattr(best, "pose", None) is not None:
        try:
            rec["yaw"] = float(best.pose[1])
        except Exception:
            pass
    rec["blur"] = face_blur(img, best)

    role, why = classify_registration_face(rec["size"], rec["det"],
                                           rec["yaw"], rec["blur"])
    rec["reason"] = why
    if role is None:
        return rec
    emb = getattr(best, "normed_embedding", None)
    if emb is None:
        emb = getattr(best, "embedding", None)
    if emb is None:
        rec["reason"] = "no_embedding"
        return rec
    rec["role"] = role
    rec["accepted"] = True
    rec["embedding"] = l2_normalise(emb)
    return rec


def load_employee(face_app, folder):
    """Every photo in one employee folder, and the gallery they produce."""
    files = sorted(f for f in os.listdir(folder)
                   if not f.startswith(".")
                   and f.lower().endswith(REGISTERED_EXTS))
    skipped = sorted(f for f in os.listdir(folder)
                     if not f.startswith(".")
                     and not f.lower().endswith(REGISTERED_EXTS)
                     and os.path.isfile(os.path.join(folder, f)))
    photos = [analyse_photo(face_app, os.path.join(folder, f)) for f in files]
    accepted = [p for p in photos if p["accepted"]]
    return {
        "folder": folder,
        "files": files,
        "skipped_files": skipped,
        "photos": photos,
        "embeddings": [p["embedding"] for p in accepted],
        "core_anchors": sum(1 for p in accepted if p["role"] == "core_anchor"),
        "support_views": sum(1 for p in accepted
                             if p["role"] == "support_view"),
        "accepted": len(accepted),
        "rejected": len(photos) - len(accepted),
        "total": len(files),
    }


def gallery_spread(embs):
    """How much variety a gallery holds: the widest distance inside it.

    A gallery of near-identical photos describes one pose and one moment. It
    will match that pose and refuse everything else, which reads as "the
    system does not recognise me" rather than as a thin photo set.
    """
    if len(embs) < 2:
        return 0.0
    return max(cosine_distance(embs[i], embs[j])
               for i in range(len(embs)) for j in range(i + 1, len(embs)))


def load_registered_employees(face_app, directory=None, verbose=True):
    """Build the in-memory gallery: {name: [embedding, ...]}.

    Returns (gallery, report). Only folders count as employees — loose files
    at the top of REGISTERED_PEOPLE belong to nobody, and guessing which
    employee an unfiled photo shows is exactly the kind of inference this
    prototype must never make.
    """
    directory = directory or REGISTERED_PEOPLE_DIR
    gallery, report = OrderedDict(), OrderedDict()
    if not os.path.isdir(directory):
        if verbose:
            print(f"   no REGISTERED_PEOPLE directory at {directory}")
        return gallery, report

    # A leading underscore marks bookkeeping, not a person: _archive holds
    # photos HR has withdrawn. Listing it as an employee gave a folder with
    # no face a readiness verdict, which is a statement about nobody.
    names = sorted(d for d in os.listdir(directory)
                   if not d.startswith(".") and not d.startswith("_")
                   and os.path.isdir(os.path.join(directory, d)))
    for name in names:
        if verbose:
            print(f"   reading {name} ...", flush=True)
        r = load_employee(face_app, os.path.join(directory, name))
        r["spread"] = gallery_spread(r["embeddings"])
        report[name] = r
        gallery[name] = r["embeddings"]
    return gallery, report


# ── separation between employees ─────────────────────────────────
def pairwise_separation(gallery):
    """Nearest distance between every pair of employees.

    This is the number that decides whether identification is possible at
    all. One person's gallery being tight says nothing on its own: if two
    employees' galleries overlap, no threshold separates them, and a
    punch-in that has to choose between them will sometimes choose wrong.
    """
    names = [n for n in gallery if gallery[n]]
    pairs = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            d = min(cosine_distance(x, y)
                    for x in gallery[a] for y in gallery[b])
            pairs.append((a, b, d))
    pairs.sort(key=lambda p: p[2])
    return pairs


def nearest_other(pairs, name):
    for a, b, d in pairs:                      # already sorted, nearest first
        if a == name:
            return b, d
        if b == name:
            return a, d
    return None, None


def readiness(rec, nearest_dist):
    """Is this employee usable for punch-in, and if not, what is missing?"""
    problems = []
    if rec["core_anchors"] < REG_MIN_CORE_ANCHORS:
        problems.append(f"needs {REG_MIN_CORE_ANCHORS - rec['core_anchors']} "
                        f"more core anchor(s)")
    if len(rec["embeddings"]) < REG_MIN_TOTAL_EMBEDS:
        problems.append(f"needs "
                        f"{REG_MIN_TOTAL_EMBEDS - len(rec['embeddings'])} "
                        f"more accepted photo(s)")
    if nearest_dist is not None and nearest_dist < REG_MIN_SEPARATION:
        problems.append(f"too close to another employee "
                        f"({nearest_dist:.3f} < {REG_MIN_SEPARATION})")
    return ("READY" if not problems else "NOT_READY"), problems


# ── report ───────────────────────────────────────────────────────
def print_report(gallery, report):
    pairs = pairwise_separation(gallery)
    print()
    print("=" * 78)
    print("  REGISTERED EMPLOYEES")
    print("=" * 78)
    if not report:
        print("  no employee folders found")
        return pairs

    ready = 0
    for name, r in report.items():
        near_name, near_d = nearest_other(pairs, name)
        state, problems = readiness(r, near_d)
        ready += (state == "READY")
        mark = "OK " if state == "READY" else "-- "
        print(f"\n  {mark}{name}")
        print(f"      images found      : {r['total']}")
        print(f"      accepted          : {r['accepted']}  "
              f"(core {r['core_anchors']}, support {r['support_views']})")
        print(f"      rejected          : {r['rejected']}")
        print(f"      embeddings loaded : {len(r['embeddings'])}")
        print(f"      gallery spread    : {r['spread']:.3f}")
        if near_name:
            print(f"      nearest employee  : {near_name} at {near_d:.3f}")
        if r["skipped_files"]:
            print(f"      skipped (format)  : {len(r['skipped_files'])} "
                  f"({', '.join(sorted({os.path.splitext(f)[1].lower() for f in r['skipped_files']}))})")
        print(f"      readiness         : {state}")
        for p in problems:
            print(f"                          - {p}")

        # Rejections are calibration data, not noise: each one names the
        # measurement that failed and the value it reached.
        refused = [p for p in r["photos"] if not p["accepted"]]
        if refused:
            by_reason = {}
            for p in refused:
                key = str(p["reason"]).split("(")[0].split("=")[0]
                by_reason.setdefault(key, []).append(p)
            print(f"      rejection reasons :")
            for why, ps in sorted(by_reason.items(),
                                  key=lambda kv: -len(kv[1])):
                print(f"                          {why:<14s} {len(ps):3d}")
                for p in ps[:3]:
                    print(f"                             {p['file']}  "
                          f"size={_f(p['size'])} det={_f(p['det'], 2)} "
                          f"yaw={_f(p['yaw'])} blur={_f(p['blur'])}")
                if len(ps) > 3:
                    print(f"                             "
                          f"... {len(ps) - 3} more")

    print()
    print("-" * 78)
    print("  SEPARATION BETWEEN EMPLOYEES (nearest gallery distance)")
    print("-" * 78)
    if not pairs:
        print("  fewer than two employees have embeddings — nothing to "
              "separate")
    for a, b, d in pairs:
        flag = "TOO CLOSE" if d < REG_MIN_SEPARATION else "ok"
        print(f"      {a:<12s} <-> {b:<12s} {d:.3f}   {flag}")

    print()
    print(f"  {ready}/{len(report)} employee(s) ready for punch-in")
    return pairs


def _f(v, nd=0):
    return "-" if v is None else f"{v:.{nd}f}"


# ── live verification ────────────────────────────────────────────
def is_live_quality_face(face):
    """Is this frame's face worth measuring at all?"""
    fx1, fy1, fx2, fy2 = face.bbox
    fw, fh = fx2 - fx1, fy2 - fy1
    if fw < LIVE_MIN_FACE_SIZE or fh < LIVE_MIN_FACE_SIZE:
        return False, f"small({fw:.0f}x{fh:.0f})"
    det = float(getattr(face, "det_score", 0.0))
    if det < LIVE_MIN_DET_SCORE:
        return False, f"det={det:.2f}"
    if getattr(face, "pose", None) is not None:
        try:
            yaw = float(face.pose[1])
        except Exception:
            yaw = None
        if yaw is not None and abs(yaw) > LIVE_MAX_YAW:
            return False, f"yaw={yaw:.0f}"
    return True, "ok"


def identify(emb, gallery):
    """Nearest registered employee to this face, and how clear the win is.

    Returns (state, name, best, second, margin). The distance to a PERSON is
    the distance to their nearest photo — a gallery is a set of views of one
    face, so the closest view is what the person is being measured by.

    The runner-up is a different PERSON, never another photo of the winner:
    a margin measured against the winner's own second-best photo says only
    that their gallery is consistent, which is true of everybody and rules
    nothing out.
    """
    if emb is None or not gallery:
        return "UNKNOWN", None, None, None, None
    per_person = sorted(
        ((min(cosine_distance(emb, g) for g in embs), name)
         for name, embs in gallery.items() if embs))
    if not per_person:
        return "UNKNOWN", None, None, None, None
    best, name = per_person[0]
    second = per_person[1][0] if len(per_person) > 1 else None
    margin = None if second is None else second - best

    if best >= FACE_REJECT_DIST:
        return "UNKNOWN", name, best, second, margin
    if best <= FACE_ACCEPT_DIST and (margin is None or margin >= FACE_MARGIN):
        return "MATCH", name, best, second, margin
    return "UNCERTAIN", name, best, second, margin


class VerificationGate:
    """Turns a stream of per-frame opinions into one decision.

    Holds a streak of frames agreeing on a name inside a short window. A
    different name or a stranger empties it, because both mean the streak
    was describing somebody who is no longer the person in front of the
    camera. UNCERTAIN neither confirms nor contradicts, so it is allowed to
    pass without destroying a streak — the window expires it soon enough if
    the good frames stop coming.
    """

    def __init__(self, hits=VERIFY_HITS, window=VERIFY_WINDOW_SEC):
        self.hits, self.window = hits, window
        self.name = None
        self.stamps = []
        self.verified = None
        self.verified_dist = None
        self.verified_at = None

    def release(self):
        """Let go of a finished verification so the next person can start.

        Deliberately separate from the cooldown. This frees the MACHINE; the
        cooldown governs the LOG. Collapsing them would mean either the
        screen stays stuck on one name for the whole cooldown, or releasing
        the screen also permits a duplicate row.
        """
        self.verified = None
        self.verified_dist = None
        self.verified_at = None
        self.reset()

    def reset(self):
        self.name, self.stamps = None, []

    def update(self, state, name=None, dist=None, now=None, detail=""):
        """Returns the display string for this frame.

        Every frame goes through here, including the ones with no usable
        face. Letting those set the display directly meant an empty frame
        overwrote a completed verification, and the punch-in flickered
        between VERIFIED and NO_FACE for the rest of the run.
        """
        if self.verified:
            return f"VERIFIED {self.verified}"

        if state in ("NO_FACE", "NO_USABLE_FACE"):
            # Nobody to contradict the streak, but nobody to extend it
            # either. The window expires it if they have really gone.
            return state + detail
        if state == "UNKNOWN":
            self.reset()
            return "UNKNOWN"
        if state == "UNCERTAIN":
            return "UNCERTAIN"
        if state != "MATCH":
            return state

        if name != self.name:
            self.name, self.stamps = name, []
        self.stamps = [t for t in self.stamps if now - t < self.window]
        self.stamps.append(now)
        if len(self.stamps) >= self.hits:
            self.verified, self.verified_dist = name, dist
            self.verified_at = now
            return f"VERIFIED {name}"
        return f"MATCHING {name} {len(self.stamps)}/{self.hits}"


def read_attendance_history(path):
    """Every employee's most recent punch, recovered from the CSV.

    Returns (last_punch, skipped, rows_read) where last_punch maps a name to
    epoch seconds — the same clock the running cooldown uses, so the two are
    directly comparable.

    Nothing in here may raise. This runs before the camera opens, and a log
    that has been hand-edited, truncated by a power cut or opened in a
    spreadsheet is a reason to skip a row, never a reason for the punch-in
    machine to refuse to start.
    """
    last, skipped, rows_read = {}, [], 0
    if not path or not os.path.isfile(path):
        return last, skipped, rows_read
    try:
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            table = list(csv.reader(f))
    except OSError as e:
        return last, [{"line": 0, "why": f"unreadable:{type(e).__name__}"}], 0

    # Read the column order from the header when there is one, so a file
    # whose columns were rearranged is still understood rather than
    # silently misread a name as a timestamp.
    idx = {name: i for i, name in enumerate(ATTENDANCE_HEADER)}
    start = 0
    if table and [c.strip() for c in table[0]] == ATTENDANCE_HEADER:
        idx = {name: i for i, name in enumerate(c.strip() for c in table[0])}
        start = 1
    elif table and "employee" in [c.strip() for c in table[0]]:
        idx = {name: i for i, name in enumerate(c.strip() for c in table[0])}
        start = 1

    for line, row in enumerate(table[start:], start=start + 1):
        if not row or not any(c.strip() for c in row):
            continue                       # blank line, not a bad row
        rows_read += 1
        need = max(idx.get("employee", 3), idx.get("timestamp_iso", 0))
        if len(row) <= need:
            skipped.append({"line": line, "why": "short_row"})
            continue
        name = row[idx["employee"]].strip()
        stamp = row[idx["timestamp_iso"]].strip()
        if not name:
            skipped.append({"line": line, "why": "no_employee"})
            continue
        try:
            when = datetime.fromisoformat(stamp).timestamp()
        except (ValueError, OSError, OverflowError):
            skipped.append({"line": line, "why": "bad_timestamp",
                            "employee": name})
            continue
        # Latest wins, whatever order the rows are in. A log that was
        # appended to by two machines is not necessarily sorted.
        if name not in last or when > last[name]:
            last[name] = when
    return last, skipped, rows_read


def print_attendance_status(path, cooldown=PUNCH_COOLDOWN_SEC):
    """What the log says right now, without opening a camera or a model."""
    last, skipped, rows_read = read_attendance_history(path)
    now = time.time()
    print()
    print("=" * 78)
    print("  ATTENDANCE STATUS")
    print("=" * 78)
    print(f"  log      : {path}")
    if not os.path.isfile(path):
        print("  state    : no log yet — the next run starts fresh")
        return 0
    print(f"  rows     : {rows_read}   cooldown: {cooldown:.0f}s")
    if not last:
        print("  employees: none recorded")
    else:
        print(f"\n  {'employee':<14s} {'latest punch':<21s} "
              f"{'ago':>10s} {'cooldown':>12s}")
        for name in sorted(last, key=lambda n: -last[n]):
            ago = now - last[name]
            remain = cooldown - ago
            stamp = datetime.fromtimestamp(last[name]).isoformat(
                timespec="seconds")
            state = (f"{remain:.0f}s left" if remain > 0 else "expired")
            # A punch stamped in the future means the clock moved, not that
            # somebody punched in ahead of time. Say so rather than printing
            # a negative age as if it were meaningful.
            ago_s = f"{ago:.0f}s" if ago >= 0 else "in future!"
            print(f"  {name:<14s} {stamp:<21s} {ago_s:>10s} {state:>12s}")
    if skipped:
        print(f"\n  malformed rows skipped: {len(skipped)}")
        for r in skipped[:10]:
            print(f"     line {r['line']:<5d} {r['why']}"
                  f"{'  ' + r['employee'] if r.get('employee') else ''}")
        if len(skipped) > 10:
            print(f"     ... {len(skipped) - 10} more")
    return 0


class AttendanceLog:
    """One row per punch-in, and the rules about when a row is allowed.

    The rules live here rather than in the frame loop so that every way of
    reaching a write — a verification, a re-verification after the screen
    resets, a second camera later — passes the same three checks: the name
    is registered, the log is enabled, and the cooldown has expired.
    """

    def __init__(self, path=ATTENDANCE_LOG, cooldown=PUNCH_COOLDOWN_SEC,
                 enabled=True, registered=(), seed=True):
        self.path = path
        self.cooldown = float(cooldown)
        self.enabled = bool(enabled)
        # The closed set of names that may ever appear in the file. A punch
        # is only ever attempted for a verified match, but the guarantee is
        # worth holding HERE, at the write, where nothing can route round it.
        self.registered = set(registered)
        self.last_punch = {}
        self.rows_written = 0
        # Names filed BY THIS RUN, kept apart from last_punch, which also
        # holds everyone recovered from the log. Reporting the union as
        # "punched in" credited this run with rows it never wrote.
        self.punched_this_run = []
        self.skipped_rows = []
        self.seeded_from_log = 0
        if seed:
            # The cooldown belongs to the LOG, not to this process. Keeping
            # it only in memory meant a restart — a crash, a power cut, an
            # operator relaunching the machine — silently forgave it, and
            # the person still standing there could file a second row.
            self.last_punch, self.skipped_rows, _n = read_attendance_history(
                path)
            self.seeded_from_log = len(self.last_punch)

    def describe_seed(self):
        """One line about what was recovered, for the run's first output."""
        if not os.path.isfile(self.path):
            return "no previous log — starting fresh"
        bits = [f"{self.seeded_from_log} employee(s) recovered from log"]
        if self.skipped_rows:
            bits.append(f"{len(self.skipped_rows)} malformed row(s) skipped")
        return ", ".join(bits)

    def _ensure_file(self):
        """Create ATTENDANCE/ and the header, once."""
        d = os.path.dirname(self.path)
        if d:
            os.makedirs(d, exist_ok=True)
        fresh = (not os.path.isfile(self.path)
                 or os.path.getsize(self.path) == 0)
        if fresh:
            with open(self.path, "w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(ATTENDANCE_HEADER)

    def seconds_since(self, name, now):
        last = self.last_punch.get(name)
        return None if last is None else (now - last)

    def punch(self, name, distance, source, now=None):
        """Try to file one attendance row.

        Returns (status, detail) where status is one of:
            written | cooldown | not_registered | disabled
        """
        now = time.time() if now is None else now
        if name not in self.registered:
            # Unreachable through the normal path, and kept anyway: this is
            # the last line before the file, and a guarantee that depends on
            # every caller being correct is not a guarantee.
            return "not_registered", name

        since = self.seconds_since(name, now)
        if since is not None and since < self.cooldown:
            return "cooldown", since

        if not self.enabled:
            # A dry run still holds the cooldown, so --no-log exercises the
            # same sequence of decisions a real run would make.
            self.last_punch[name] = now
            return "disabled", None

        stamp = datetime.now()
        self._ensure_file()
        with open(self.path, "a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow([
                stamp.isoformat(timespec="seconds"),
                stamp.strftime("%Y-%m-%d"),
                stamp.strftime("%H:%M:%S"),
                name,
                ("" if distance is None else f"{distance:.4f}"),
                str(source)])
        self.last_punch[name] = now
        self.rows_written += 1
        if name not in self.punched_this_run:
            self.punched_this_run.append(name)
        return "written", stamp.isoformat(timespec="seconds")


def is_camera_source(spec):
    """Is this a local capture device rather than a file or a URL?"""
    return isinstance(spec, int) or (isinstance(spec, str) and spec.isdigit())


def resolve_mirror(flag, source):
    """Should the PREVIEW be flipped left-to-right?

    On by default for a local camera, because a person adjusting their
    position in front of an unmirrored selfie view moves the wrong way. Off
    for a file or an RTSP stream, where the image is a record of a scene
    rather than a mirror the subject is standing in.

    An explicit --mirror / --no-mirror always wins.
    """
    if flag is not None:
        return bool(flag)
    return is_camera_source(source)


def open_source(spec, width=None, height=None):
    """Camera index or any OpenCV-readable source (file, RTSP, HTTP)."""
    if is_camera_source(spec):
        cap = cv2.VideoCapture(int(spec))
        # Only a camera has a resolution to ask for. Setting these on a
        # file would silently ask the decoder to rescale the recording.
        if width:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(width))
        if height:
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(height))
    else:
        cap = cv2.VideoCapture(spec)
    return cap


def mirror_box(box, frame_width):
    """The same box, in a horizontally flipped frame."""
    if box is None:
        return None
    x1, y1, x2, y2 = [float(v) for v in box]
    return [frame_width - x2, y1, frame_width - x1, y2]


def kiosk_status(label):
    """The internal frame label, said in words a person can act on.

    The loop's own vocabulary is diagnostic — NO_USABLE_FACE, UNCERTAIN,
    NO_FACE. None of it tells the person at the machine anything they can
    do. This is the translation, and it is a pure function so the wording
    can be tested without a camera.
    """
    if not label:
        return KIOSK_READY
    head = label.split()[0]
    if head in ("NO_FACE", "READY"):
        # Nobody is there, or nobody has been there long enough to matter.
        return KIOSK_READY
    if head in ("NO_USABLE_FACE", "UNCERTAIN"):
        # A face IS present and cannot be used. "Look at the camera" is the
        # only instruction that ever fixes it — too far, too turned, too dim
        # all resolve the same way.
        return KIOSK_LOOK
    if head == "UNKNOWN":
        return KIOSK_UNKNOWN
    if head == "REFUSED":
        return "NOT REGISTERED"
    if head == "PUNCHED":
        return label.replace("PUNCHED IN", "PUNCHED IN")
    return label                      # MATCHING/VERIFIED/COOLDOWN <name>


def kiosk_colour(status):
    return KIOSK_COLOURS.get(status.split()[0], KIOSK_COLOURS["READY"])


def draw_kiosk(frame, box, status, detail=None, window_h=None):
    """The whole kiosk screen: one face box, one line of large text.

    No tracking boxes, no per-frame numbers. A punch-in machine that shows
    its workings invites the person to interpret them, and there is nothing
    useful for them to conclude from a cosine distance.
    """
    h, w = frame.shape[:2]
    colour = kiosk_colour(status)
    if box is not None:
        x1, y1, x2, y2 = [int(v) for v in box]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 3)

    # A dark band behind the text, so the words stay readable against a
    # bright doorway or a dark corridor without tuning either.
    scale = max(1.0, w / 900.0)
    band = int(78 * scale)
    strip = frame[h - band:h, 0:w]
    if strip.size:
        frame[h - band:h, 0:w] = (strip * 0.35).astype(frame.dtype)

    size, thick = 1.25 * scale, max(2, int(3 * scale))
    (tw, th), _ = cv2.getTextSize(status, cv2.FONT_HERSHEY_SIMPLEX, size,
                                  thick)
    cv2.putText(frame, status, (max(12, (w - tw) // 2),
                                h - band + th + int(14 * scale)),
                cv2.FONT_HERSHEY_SIMPLEX, size, colour, thick,
                cv2.LINE_AA)
    if detail:
        cv2.putText(frame, detail, (12, int(28 * scale)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55 * scale, (200, 200, 200),
                    max(1, int(1.4 * scale)), cv2.LINE_AA)
    return frame


def draw_overlay(frame, box, label, state):
    colour = {"VERIFIED": (60, 200, 60), "MATCHING": (60, 200, 200),
              "UNCERTAIN": (40, 150, 235), "UNKNOWN": (60, 60, 220)}.get(
                  label.split()[0], (180, 180, 180))
    if box is not None:
        x1, y1, x2, y2 = [int(v) for v in box]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
        cv2.putText(frame, label, (x1, max(20, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2)
    cv2.putText(frame, state, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                colour, 2)
    return frame


def run_live(face_app, gallery, source, show_window=True, hits=VERIFY_HITS,
             window_sec=VERIFY_WINDOW_SEC, log=None, auto_reset=AUTO_RESET_SEC,
             once=False, kiosk=False, debug=False, mirror=None,
             window_name=WINDOW_NAME, show_distance=False,
             cam_width=CAMERA_WIDTH, cam_height=CAMERA_HEIGHT):
    """Verify whoever is in front of the camera, and punch them in.

    The cycle is: verify -> log -> hold the result on screen -> release, and
    it repeats for as long as the machine runs. Releasing frees the screen;
    it does not forgive the cooldown, so the person still standing there
    when the screen clears cannot file a second row.
    """
    if not gallery:
        print("no registered employees loaded — nothing to verify against")
        return 2
    cap = open_source(source, cam_width, cam_height)
    if not cap or not cap.isOpened():
        print(f"could not open source: {source!r}")
        return 2

    mirrored = resolve_mirror(mirror, source)
    # Kiosk means "somebody is standing here to punch in", so the console
    # says only what an operator watching over their shoulder needs. The
    # diagnostic stream is still one --debug away.
    verbose = debug or not kiosk

    if log is None:
        log = AttendanceLog(enabled=False, registered=gallery)
    print(f"source open: {source}   employees: {', '.join(gallery)}")
    print(f"attendance: "
          f"{log.path if log.enabled else 'DISABLED (--no-log)'}   "
          f"cooldown={log.cooldown:.0f}s   reset={auto_reset:.0f}s")
    print(f"            {log.describe_seed()}")
    if kiosk:
        print(f"kiosk: window={window_name!r} mirror={mirrored} "
              f"distance={'shown' if show_distance else 'hidden'}")
    print("keys: q quit   r reset   s attendance status")
    gate = VerificationGate(hits, window_sec)
    last_printed = None
    windowed = show_window
    frames = 0
    # The verification is announced once. It is a single event, not a state
    # to be restated every time the subject blinks.
    announced = False
    punched = None          # display string once this verification is filed
    punch_done = False      # this verification has had its one attempt
    window_ready = False    # the kiosk window is created on first use
    # Who this run actually recognised. gate.verified is cleared by every
    # release, so at the end of a stream it says nothing about whether
    # anybody was ever verified — which read as "nobody verified" after a
    # dry run had verified the same person twice.
    verified_this_run = []

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                print("end of stream")
                break
            frames += 1
            now = time.time()

            try:
                faces = face_app.get(frame)
            except Exception as e:
                print(f"detect error: {type(e).__name__}")
                faces = []

            box, detail = None, ""
            state, name, best = "NO_FACE", None, None
            if faces:
                # One camera, one person: the largest face is the subject.
                best_face = max(faces, key=lambda f: ((f.bbox[2] - f.bbox[0])
                                                      * (f.bbox[3] - f.bbox[1])))
                box = best_face.bbox
                good, why = is_live_quality_face(best_face)
                if not good:
                    # There IS a face; it is not measurable. Saying NO_FACE
                    # would send somebody looking for a detection problem
                    # when the answer is "turn towards the camera".
                    state, detail = "NO_USABLE_FACE", f" ({why})"
                else:
                    emb = getattr(best_face, "normed_embedding", None)
                    if emb is None:
                        emb = getattr(best_face, "embedding", None)
                    emb = None if emb is None else l2_normalise(emb)
                    state, name, best, second, margin = identify(emb,
                                                                  gallery)
                    detail = (f" best={name}:{_f(best, 3)} "
                              f"second={_f(second, 3)} "
                              f"margin={_f(margin, 3)}")

            label = gate.update(state, name, best, now, detail)

            # ── verification -> attendance ────────────────────
            # Exactly one attempt per verification. Retrying every frame
            # would print the cooldown refusal at the frame rate, and a
            # refusal repeated 500 times reads like a fault.
            if gate.verified and not punch_done:
                punch_done = True
                if gate.verified not in verified_this_run:
                    verified_this_run.append(gate.verified)
                if not announced:
                    print(f"VERIFIED: {gate.verified} "
                          f"dist={gate.verified_dist:.3f}")
                    announced = True
                status, info = log.punch(gate.verified, gate.verified_dist,
                                         source, now)
                if status == "written":
                    print(f"PUNCH_IN: {gate.verified} time={info} "
                          f"log={log.path}")
                    punched = f"PUNCHED IN {gate.verified}"
                elif status == "disabled":
                    print(f"PUNCH_IN: {gate.verified} (not written, "
                          f"--no-log)")
                    punched = f"PUNCHED IN {gate.verified}"
                elif status == "cooldown":
                    print(f"COOLDOWN: {gate.verified} already punched in "
                          f"{info:.0f}s ago")

                    punched = f"COOLDOWN {gate.verified}"
                else:
                    print(f"REFUSED: {gate.verified} is not a registered "
                          f"employee — nothing written")
                    punched = "REFUSED"
                last_printed = punched
                if once and status == "written":
                    break

            if punched:
                label = punched

            # ── release the machine for the next person ───────
            if gate.verified and gate.verified_at is not None \
                    and (now - gate.verified_at) >= auto_reset:
                print("READY_FOR_NEXT_PERSON")
                gate.release()
                announced, punched, punch_done = False, None, False
                last_printed = "READY"
                label = "READY"

            # Only when the answer changes. A per-frame log at 25fps is a
            # wall of identical lines that hides the moment it mattered.
            if label != last_printed:
                if not gate.verified and verbose:
                    print(f"{label}{detail if 'best=' in detail else ''}")
                last_printed = label

            if windowed:
                try:
                    shown = frame
                    shown_box = box
                    if mirrored:
                        # The PREVIEW is flipped, never the frame that was
                        # measured. Recognising a mirrored face would change
                        # every distance in the system for a purely cosmetic
                        # reason, so the image is detected as captured and
                        # only the picture on screen is turned round.
                        shown = cv2.flip(frame, 1)
                        shown_box = mirror_box(box, shown.shape[1])
                    if kiosk:
                        if not window_ready:
                            cv2.namedWindow(window_name,
                                            cv2.WINDOW_NORMAL)
                            cv2.setWindowProperty(
                                window_name, cv2.WND_PROP_FULLSCREEN,
                                cv2.WINDOW_FULLSCREEN)
                            window_ready = True
                        det = None
                        if show_distance and "best=" in detail:
                            det = detail.strip()
                        cv2.imshow(window_name,
                                   draw_kiosk(shown, shown_box,
                                              kiosk_status(label), det))
                    else:
                        cv2.imshow(window_name,
                                   draw_overlay(shown, shown_box, label,
                                                label))
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("q"):
                        print("quit")
                        break
                    if key == ord("r"):
                        # Clears the SCREEN, never the record. The cooldown
                        # lives in the log; a key on the machine must not be
                        # able to grant somebody a second punch-in.
                        gate.release()
                        announced, punched, punch_done = False, None, False
                        last_printed = "READY"
                        print("MANUAL_RESET")
                        print("READY_FOR_NEXT_PERSON")
                    if key == ord("s"):
                        print_attendance_status(log.path, log.cooldown)
                except cv2.error:
                    # No display (headless run, no GUI build). Verification
                    # is the job; the preview is not, so it is dropped and
                    # the run continues rather than failing.
                    print("no display available — continuing without preview")
                    windowed = False
    except KeyboardInterrupt:
        print("interrupted")
    finally:
        cap.release()
        if show_window:
            try:
                cv2.destroyAllWindows()
            except cv2.error:
                pass


    print(f"frames processed: {frames}")
    print(f"attendance rows written: {log.rows_written}")
    if log.punched_this_run:
        print(f"punched in: {', '.join(sorted(log.punched_this_run))}")
    if verified_this_run:
        unfiled = [n for n in verified_this_run
                   if n not in log.punched_this_run]
        if unfiled:
            print(f"verified but not filed: {', '.join(sorted(unfiled))}"
                  f"{' (--no-log)' if not log.enabled else ' (cooldown)'}")
    elif not log.punched_this_run:
        print("result: nobody verified")
    return 0


# ── CLI ──────────────────────────────────────────────────────────
def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Face-biometric punch-in prototype (registration check).")
    ap.add_argument("--check-registered", action="store_true",
                    help="load REGISTERED_PEOPLE and print a readiness "
                         "report")
    ap.add_argument("--registered-dir", default=REGISTERED_PEOPLE_DIR,
                    help="override the REGISTERED_PEOPLE directory")
    ap.add_argument("--camera", metavar="INDEX",
                    help="verify against a local camera by index, e.g. 0")
    ap.add_argument("--source", metavar="URL_OR_FILE",
                    help="verify against an RTSP URL or a video file")
    ap.add_argument("--no-window", action="store_true",
                    help="skip the preview window (headless runs)")
    ap.add_argument("--kiosk", action="store_true",
                    help="full-screen operator display: large status text, "
                         "face box only, quiet console")
    ap.add_argument("--window-name", default=WINDOW_NAME,
                    help=f"title of the preview window "
                         f"(default {WINDOW_NAME!r})")
    ap.add_argument("--mirror", action="store_true", default=None,
                    help="flip the preview left-to-right "
                         "(default: on for --camera, off for --source)")
    ap.add_argument("--no-mirror", dest="mirror", action="store_false",
                    help="never flip the preview")
    ap.add_argument("--camera-width", type=int, default=CAMERA_WIDTH,
                    metavar="PX",
                    help=f"requested camera width, cameras only "
                         f"(default {CAMERA_WIDTH})")
    ap.add_argument("--camera-height", type=int, default=CAMERA_HEIGHT,
                    metavar="PX",
                    help=f"requested camera height, cameras only "
                         f"(default {CAMERA_HEIGHT})")
    ap.add_argument("--show-distance", action="store_true",
                    help="overlay the distance and margin on the preview")
    ap.add_argument("--debug", action="store_true",
                    help="keep the per-state console detail in kiosk mode")
    ap.add_argument("--hits", type=int, default=VERIFY_HITS,
                    help=f"matching frames needed to verify "
                         f"(default {VERIFY_HITS})")
    ap.add_argument("--window-sec", type=float, default=VERIFY_WINDOW_SEC,
                    help=f"seconds those frames must fall within "
                         f"(default {VERIFY_WINDOW_SEC})")
    ap.add_argument("--attendance-log", default=ATTENDANCE_LOG,
                    metavar="PATH",
                    help=f"attendance CSV (default {ATTENDANCE_LOG})")
    ap.add_argument("--cooldown-sec", type=float,
                    default=PUNCH_COOLDOWN_SEC,
                    help=f"seconds before the same employee may punch in "
                         f"again (default {PUNCH_COOLDOWN_SEC:.0f})")
    ap.add_argument("--auto-reset-sec", type=float, default=AUTO_RESET_SEC,
                    help=f"seconds a result is held before the machine "
                         f"frees up (default {AUTO_RESET_SEC:.0f})")
    ap.add_argument("--hr-map-status", action="store_true",
                    help="show which registration folders are linked to an "
                         "HR employee, and which may punch in")
    ap.add_argument("--link-employee", metavar="FOLDER",
                    help="link a REGISTERED_PEOPLE folder to an HR employee")
    ap.add_argument("--employee-id", metavar="ID",
                    help="the HR Employee.biometricId to link the folder to")
    ap.add_argument("--employee-name", metavar="NAME",
                    help="display name recorded alongside the link")
    ap.add_argument("--mongo-id", metavar="OBJECTID",
                    help="optional HR Employee _id, recorded alongside")
    ap.add_argument("--unlink-employee", metavar="FOLDER",
                    help="remove a folder's HR link")
    ap.add_argument("--status-json", nargs="?", const="", metavar="PATH",
                    help="write the HR face-registration status as JSON "
                         "(default biometric_status.json beside this "
                         "script) and exit")
    ap.add_argument("--hr-map", metavar="PATH",
                    help="mapping file (default biometric_people.json "
                         "beside this script)")
    ap.add_argument("--attendance-status", action="store_true",
                    help="print what the attendance log already records, "
                         "then exit (no camera, no model)")
    ap.add_argument("--once", action="store_true",
                    help="exit after the first successful punch-in")
    ap.add_argument("--no-log", action="store_true",
                    help="verify but write no CSV (dry run)")
    ap.add_argument("--quiet", action="store_true",
                    help="suppress per-folder progress")
    args = ap.parse_args(argv)

    live = args.camera if args.camera is not None else args.source

    # ── HR bridge ─────────────────────────────────────────────
    # Linking and inspecting the mapping are HR bookkeeping, not
    # recognition. They are answered before any model is built, and
    # linking touches nothing but the mapping file.
    import face_biometric_service as SVC
    hr_map = args.hr_map or SVC.HR_MAP_PATH

    if args.link_employee:
        if not args.employee_id:
            print("--link-employee needs --employee-id "
                  "(the HR Employee.biometricId)")
            return 2
        ok, msg, _m = SVC.link_employee(
            args.link_employee, args.employee_id, args.employee_name,
            path=hr_map, mongo_id=args.mongo_id,
            registered_dir=args.registered_dir)
        print(("linked: " if ok else "refused: ") + msg)
        if not ok:
            return 2
        print(f"mapping: {hr_map}")
        if not args.hr_map_status:
            return 0

    if args.unlink_employee:
        ok, msg, _m = SVC.unlink_employee(args.unlink_employee, path=hr_map)
        print(("unlinked: " if ok else "refused: ") + msg)
        if not args.hr_map_status:
            return 0 if ok else 2

    if args.status_json is not None:
        path, snap = SVC.write_status_snapshot(
            args.status_json or SVC.STATUS_SNAPSHOT, args.registered_dir,
            hr_map)
        t = snap["totals"]
        print(f"wrote {path}")
        print(f"  folders={t['folders']} linked={t['linked']} "
              f"unlinked={t['unlinked']} punchable={t['punchable']} "
              f"generated_at={snap['generated_at']}")
        if not args.hr_map_status and not args.check_registered \
                and live is None:
            return 0

    if args.hr_map_status:
        rc = SVC.print_hr_map_status(args.registered_dir, hr_map)
        if not args.check_registered and live is None:
            return rc

    # Reading the log needs neither the camera nor the face model, so this
    # answers before either is touched — it is an audit command, and an
    # audit that takes thirty seconds to load a model will not be run.
    if args.attendance_status:
        rc = print_attendance_status(args.attendance_log, args.cooldown_sec)
        if not args.check_registered and live is None:
            return rc

    if not args.check_registered and live is None:
        ap.print_help()
        return 0
    if args.camera is not None and args.source is not None:
        print("give either --camera or --source, not both")
        return 2

    print(f"Loading {FACE_MODEL_NAME} ...")
    face_app = build_face_app(verbose=not args.quiet)
    print(f"Reading {args.registered_dir}")
    gallery, report = load_registered_employees(
        face_app, args.registered_dir, verbose=not args.quiet)

    if args.check_registered:
        print_report(gallery, report)
    if live is None:
        return 0

    # Only employees with embeddings can be matched against. An employee
    # whose photos all failed the gate is not silently absent — the reason
    # is in --check-registered, and matching them here would need a gallery
    # that does not exist.
    usable = OrderedDict((n, e) for n, e in gallery.items() if e)
    missing = [n for n in gallery if not gallery[n]]
    if missing:
        print(f"not matchable (no accepted photos): {', '.join(missing)}")
    # The set of names that may reach the CSV is fixed here, from the
    # gallery, and never grows during a run.
    log = AttendanceLog(args.attendance_log, args.cooldown_sec,
                        enabled=not args.no_log, registered=usable,
                        seed=True)
    return run_live(face_app, usable, live, show_window=not args.no_window,
                    hits=args.hits, window_sec=args.window_sec, log=log,
                    auto_reset=args.auto_reset_sec, once=args.once,
                    kiosk=args.kiosk, debug=args.debug, mirror=args.mirror,
                    window_name=args.window_name,
                    show_distance=args.show_distance,
                    cam_width=args.camera_width,
                    cam_height=args.camera_height)


if __name__ == "__main__":
    sys.exit(main())
