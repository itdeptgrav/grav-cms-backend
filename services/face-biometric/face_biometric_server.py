#!/usr/bin/env python3
"""
face_biometric_server.py — the face engine, as a small local service.

The HR API is a Node process. The face engine is Python, and loading its
model takes seconds. Shelling out per frame would pay that cost on every
capture, so instead the engine runs once, holds the gallery in memory, and
answers over HTTP on localhost.

What this service is NOT:

    it does not sign anybody in — it says who a face looks like, and the
    Node API decides what that is worth;
    it does not write attendance;
    it does not keep the frames it is sent, unless started with --debug.

The verification rule is not re-implemented here. Every threshold and the
3-frames-in-2-seconds gate come from face_biometric.py by import, so the
kiosk and the browser cannot drift apart: change the rule in one place and
both follow.

Session scoping matters more than it looks. Two people signing in from two
browsers must not pool their frames into one streak — that would let two
half-recognitions add up to somebody being verified. Each session_id gets
its own gate, and gates expire.

    python face_biometric_server.py --port 5001
    python face_biometric_server.py --port 5001 --debug   # keeps frames
"""

import argparse
import base64
import binascii
import json
import os
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

import face_biometric as FB
import face_biometric_service as SVC

DEFAULT_PORT = 5001
# One frame of a webcam, generously. A request larger than this is not a
# face capture, so it is refused before it is decoded rather than after.
MAX_BODY_BYTES = 6 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000          # refuse decompression bombs
# Registration uploads carry several photos at once, so they get their own,
# larger ceiling — still bounded, and still refused before the body is read.
MAX_UPLOAD_BODY_BYTES = 80 * 1024 * 1024
# A gate nobody has fed for this long is somebody who walked away.
SESSION_TTL_SEC = 120.0
MAX_SESSIONS = 500
# The smallest gap between two frames of one session that we will consider.
# Below this a client is not capturing, it is hammering.
MIN_FRAME_INTERVAL_SEC = 0.08

# Statuses this service returns. VERIFIED_BUT_UNLINKED is the one that
# matters: the face was recognised and there is no employee to be. It is a
# refusal, not a success, and it is named so the caller cannot mistake it
# for one.
S_VERIFIED = "VERIFIED"
S_VERIFIED_UNLINKED = "VERIFIED_BUT_UNLINKED"
S_MATCHING = "MATCHING"
S_UNKNOWN = "UNKNOWN"
S_UNCERTAIN = "UNCERTAIN"
S_NO_FACE = "NO_FACE"
S_NO_USABLE = "NO_USABLE_FACE"


class SessionGates:
    """One verification gate per browser session, with expiry."""

    def __init__(self, hits, window, ttl=SESSION_TTL_SEC):
        self.hits, self.window, self.ttl = hits, window, ttl
        self._gates = {}
        self._seen = {}
        self._lock = threading.Lock()

    def _evict(self, now):
        dead = [k for k, t in self._seen.items() if now - t > self.ttl]
        for k in dead:
            self._gates.pop(k, None)
            self._seen.pop(k, None)
        # A cap as well as a TTL: a caller inventing a new session id per
        # request would otherwise grow this without bound.
        if len(self._gates) > MAX_SESSIONS:
            for k, _t in sorted(self._seen.items(),
                                key=lambda kv: kv[1])[:len(self._gates)
                                                      - MAX_SESSIONS]:
                self._gates.pop(k, None)
                self._seen.pop(k, None)

    def get(self, sid, now):
        with self._lock:
            self._evict(now)
            g = self._gates.get(sid)
            if g is None:
                g = FB.VerificationGate(self.hits, self.window)
                self._gates[sid] = g
            self._seen[sid] = now
            return g

    def reset(self, sid):
        with self._lock:
            self._gates.pop(sid, None)
            self._seen.pop(sid, None)

    def count(self):
        with self._lock:
            return len(self._gates)


class Engine:
    """Model, gallery and mapping, loaded once."""

    def __init__(self, registered_dir=None, hr_map=None, debug_dir=None):
        self.registered_dir = registered_dir
        self.hr_map = hr_map or SVC.HR_MAP_PATH
        self.debug_dir = debug_dir
        self.app = None
        self.gallery = {}
        self.report = {}
        self.loaded_at = None
        self.gates = SessionGates(FB.VERIFY_HITS, FB.VERIFY_WINDOW_SEC)
        self.requests = 0
        self._lock = threading.Lock()

    def load(self):
        print("loading face model ...", flush=True)
        self.app = FB.build_face_app(verbose=True)
        self.reload_gallery()

    def reload_gallery(self):
        # Only the punchable gallery is ever loaded: an unlinked or
        # not-ready folder is never a candidate, so it cannot be matched
        # and then refused by a caller who forgets to check.
        folders, self.report = SVC.load_registered_gallery(
            self.registered_dir, self.hr_map, verbose=False, app=self.app)
        # Keyed by EMPLOYEE, not folder: two galleries of one person must not
        # compete with each other for the margin. See merge_gallery_by_employee.
        self.gallery, self.id_to_folders = SVC.merge_gallery_by_employee(
            folders, self.hr_map)
        self.folder_gallery = folders
        self.loaded_at = datetime.now().isoformat(timespec="seconds")
        print(f"gallery: {len(self.gallery)} employee(s) usable for sign-in "
              f"— {', '.join(self.gallery) or 'none'}", flush=True)
        for eid, fl in self.id_to_folders.items():
            if len(fl) > 1:
                print(f"  {eid}: merged {len(fl)} folders ({', '.join(fl)}) "
                      f"into one identity", flush=True)
        unlinked = [f for f, r in self.report["people"].items()
                    if not r["linked"]]
        notready = [f for f, r in self.report["people"].items()
                    if r["linked"] and not r["punchable"]]
        if unlinked:
            print(f"  not usable (no HR link): {', '.join(unlinked)}",
                  flush=True)
        if notready:
            print(f"  not usable (registration): {', '.join(notready)}",
                  flush=True)
        return self.report

    def verify(self, sid, img, now=None):
        """One frame from one session. Returns the response dict."""
        now = time.time() if now is None else now
        with self._lock:
            self.requests += 1

        out = {"status": S_NO_FACE, "employee_id": None,
               "employee_name": None, "folder": None, "distance": None,
               "margin": None, "second": None,
               "frames_matched": 0, "frames_required": FB.VERIFY_HITS,
               "signed_in": False, "reason": None,
               "session_id": sid}

        if not self.gallery:
            out["reason"] = "no_employees_available_for_face_sign_in"
            return out

        try:
            faces = self.app.get(img)
        except Exception as e:
            out["reason"] = f"detect_error:{type(e).__name__}"
            return out
        if not faces:
            out["reason"] = "no_face_in_frame"
            return out

        best_face = max(faces, key=lambda f: ((f.bbox[2] - f.bbox[0])
                                              * (f.bbox[3] - f.bbox[1])))
        out["bbox"] = [float(v) for v in best_face.bbox]
        good, why = FB.is_live_quality_face(best_face)
        if not good:
            out["status"] = S_NO_USABLE
            out["reason"] = why
            return out

        emb = getattr(best_face, "normed_embedding", None)
        if emb is None:
            emb = getattr(best_face, "embedding", None)
        if emb is None:
            out["reason"] = "no_embedding"
            return out

        # `who` is an employee id now, not a folder name.
        state, who, dist, second, margin = FB.identify(
            FB.l2_normalise(emb), self.gallery)
        folders = self.id_to_folders.get(who) or []
        out.update({"folder": (folders[0] if folders else None),
                    "folders": folders,
                    "distance": dist, "second": second, "margin": margin})

        gate = self.gates.get(sid, now)
        label = gate.update(state, who, dist, now)

        if state == "UNKNOWN":
            out["status"] = S_UNKNOWN
            out["reason"] = "no_registered_employee_within_range"
            out["folder"] = None
            out["folders"] = []
            return out
        if state == "UNCERTAIN":
            out["status"] = S_UNCERTAIN
            out["reason"] = "close_but_not_conclusive"
            out["frames_matched"] = len(gate.stamps)
            return out

        out["frames_matched"] = len(gate.stamps) if not gate.verified \
            else FB.VERIFY_HITS
        link = SVC.employee_for_id(who, self.hr_map)
        if not gate.verified:
            out["status"] = S_MATCHING
            out["employee_name"] = (link or {}).get("employee_name") or who
            out["reason"] = "building_the_streak"
            return out

        # Recognised as an employee id. Whether the HR system still knows
        # that id is a separate question, and answering it wrongly is how a
        # face signs in as nobody.
        if not link or str(who).startswith("folder:"):
            out["status"] = S_VERIFIED_UNLINKED
            out["employee_name"] = folders[0] if folders else str(who)
            out["reason"] = "face_recognised_but_no_hr_employee_linked"
            return out

        out["status"] = S_VERIFIED
        out["employee_id"] = link["employee_id"]
        out["employee_name"] = link.get("employee_name") or who
        out["mongo_id"] = link.get("mongo_id")
        out["reason"] = "verified"
        # Recognition is not a session. The Node API decides what a
        # verified face entitles somebody to; this only reports it.
        out["signed_in"] = False
        return out

    def _link(self, folder):
        mapping, _err = SVC.load_hr_map(self.hr_map)
        return (mapping.get("people") or {}).get(folder)

    def _display_name(self, folder):
        link = self._link(folder)
        return (link or {}).get("employee_name") or folder

    def save_debug_frame(self, img, sid, status):
        """Only ever called when the service was started with --debug."""
        if not self.debug_dir:
            return None
        import cv2
        os.makedirs(self.debug_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        safe = "".join(c for c in str(sid) if c.isalnum() or c in "-_")[:16]
        path = os.path.join(self.debug_dir,
                            f"{stamp}_{safe}_{status}.jpg")
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return path


ENGINE = None


def decode_image(data_url_or_b64):
    """Bytes -> BGR array, refusing anything that is not a small image."""
    import cv2
    s = data_url_or_b64 or ""
    if s.startswith("data:"):
        head, _, tail = s.partition(",")
        if "base64" not in head:
            return None, "not_base64"
        # Only still images. A data URL naming any other type is not a
        # webcam capture.
        if not head.startswith(("data:image/jpeg", "data:image/jpg",
                                "data:image/png", "data:image/webp")):
            return None, "unsupported_image_type"
        s = tail
    try:
        raw = base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return None, "bad_base64"
    if len(raw) > MAX_BODY_BYTES:
        return None, "image_too_large"
    if len(raw) < 512:
        return None, "image_too_small"
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None, "undecodable_image"
    h, w = img.shape[:2]
    if h * w > MAX_IMAGE_PIXELS:
        return None, "image_dimensions_too_large"
    return img, None


class Handler(BaseHTTPRequestHandler):
    server_version = "face-biometric/1.0"

    def log_message(self, fmt, *args):
        # The default logs every request to stderr. A sign-in page polls
        # several times a second; that is a wall of noise around the lines
        # worth reading.
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Bound to localhost; the Node API is the only intended caller.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            rep = ENGINE.report or {}
            return self._json(200, {
                "ok": True,
                "model": FB.FACE_MODEL_NAME,
                "gallery": sorted(ENGINE.gallery),
                "gallery_size": len(ENGINE.gallery),
                "loaded_at": ENGINE.loaded_at,
                "sessions": ENGINE.gates.count(),
                "requests": ENGINE.requests,
                "frames_required": FB.VERIFY_HITS,
                "window_sec": FB.VERIFY_WINDOW_SEC,
                "thresholds": {"accept": FB.FACE_ACCEPT_DIST,
                               "reject": FB.FACE_REJECT_DIST,
                               "margin": FB.FACE_MARGIN},
                "debug_frames": bool(ENGINE.debug_dir),
                "totals": rep.get("totals", {}),
            })
        return self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = self.path.rstrip("/")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"ok": False, "error": "bad_length"})
        if length <= 0:
            return self._json(400, {"ok": False, "error": "empty_body"})
        limit = (MAX_UPLOAD_BODY_BYTES if path.startswith("/register/")
                 else MAX_BODY_BYTES)
        if length > limit:
            # Refused before reading: a body this size is not a webcam
            # frame, and reading it to find that out is the attack.
            return self._json(413, {"ok": False, "error": "body_too_large",
                                    "max_bytes": limit})
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"ok": False, "error": "bad_json"})

        sid = str(payload.get("session_id") or "").strip()
        if not path.startswith("/register/") and (not sid or len(sid) > 128):
            return self._json(400, {"ok": False,
                                    "error": "missing_session_id"})

        if path == "/register/upload":
            eid = payload.get("employee_id")
            files = payload.get("files") or []
            if not isinstance(files, list) or not files:
                return self._json(400, {"ok": False, "error": "no_files"})
            if len(files) > 20:
                return self._json(400, {"ok": False,
                                        "error": "too_many_files"})
            res, refusal = SVC.save_registration_photos(
                eid, files,
                employee_name=payload.get("employee_name"),
                username=payload.get("username"),
                registered_dir=ENGINE.registered_dir,
                hr_map_path=ENGINE.hr_map)
            if refusal:
                return self._json(400, {"ok": False, "error": refusal})
            # A gallery that changed on disk is stale in memory. Reloading
            # here is what makes the status the operator sees after an
            # upload the status the sign-in page will actually use.
            ENGINE.reload_gallery()
            report = SVC.employee_registration_report(
                res["folder"], ENGINE.registered_dir, ENGINE.hr_map,
                app=ENGINE.app)
            return self._json(200, {"ok": True, **res, "status": report})

        if path == "/register/archive":
            res, refusal = SVC.archive_registration_photo(
                payload.get("folder"), payload.get("filename"),
                registered_dir=ENGINE.registered_dir,
                reason=payload.get("reason"))
            if refusal:
                return self._json(400, {"ok": False, "error": refusal})
            ENGINE.reload_gallery()
            report = SVC.employee_registration_report(
                res["folder"], ENGINE.registered_dir, ENGINE.hr_map,
                app=ENGINE.app)
            return self._json(200, {"ok": True, **res, "status": report})

        if path == "/register/snapshot":
            # The whole picture, live from disk. The HR page reads this
            # instead of a file somebody has to remember to regenerate —
            # a status that needs a manual refresh is a status that is
            # wrong most of the time.
            return self._json(200, {"ok": True,
                                    "snapshot": SVC.status_snapshot(
                                        ENGINE.registered_dir,
                                        ENGINE.hr_map, app=ENGINE.app)})

        if path == "/register/photo":
            data, why = SVC.read_registration_photo(
                payload.get("folder"), payload.get("filename"),
                registered_dir=ENGINE.registered_dir)
            if data is None:
                return self._json(400, {"ok": False, "error": why})
            return self._json(200, {"ok": True, "image": data})

        if path == "/register/status":
            folder = payload.get("folder")
            report = SVC.employee_registration_report(
                folder, ENGINE.registered_dir, ENGINE.hr_map,
                app=ENGINE.app)
            if report is None:
                return self._json(404, {"ok": False,
                                        "error": "folder_not_found"})
            return self._json(200, {"ok": True, "status": report})

        if path == "/reset":
            ENGINE.gates.reset(sid)
            return self._json(200, {"ok": True, "reset": sid})

        if path == "/reload":
            rep = ENGINE.reload_gallery()
            return self._json(200, {"ok": True,
                                    "gallery": sorted(ENGINE.gallery),
                                    "totals": rep.get("totals", {})})

        if path != "/verify":
            return self._json(404, {"ok": False, "error": "not_found"})

        img, why = decode_image(payload.get("image"))
        if img is None:
            return self._json(400, {"ok": False, "error": why})

        result = ENGINE.verify(sid, img)
        # One structured line per decision. The frame and the embedding are
        # never written anywhere: a face in a log outlives the request that
        # carried it, and a log is not where biometrics belong.
        print(f"[face-engine] verify session={sid[:8]} "
              f"status={result['status']} "
              f"employee_id={result.get('employee_id')} "
              f"distance={None if result.get('distance') is None else round(result['distance'],4)} "
              f"margin={None if result.get('margin') is None else round(result['margin'],4)} "
              f"frames={result.get('frames_matched')}/{result.get('frames_required')} "
              f"faces={result.get('faces_detected')} "
              f"reason={result.get('reason')}", flush=True)
        if ENGINE.debug_dir:
            result["debug_frame"] = ENGINE.save_debug_frame(
                img, sid, result["status"])
        return self._json(200, {"ok": True, **result})


def main(argv=None):
    global ENGINE
    ap = argparse.ArgumentParser(
        description="Local face verification service for the HR sign-in "
                    "page. Recognition only — it signs nobody in and "
                    "records no attendance.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1",
                    help="default 127.0.0.1 — this service has no auth of "
                         "its own and must not be exposed")
    ap.add_argument("--registered-dir", default=None)
    ap.add_argument("--hr-map", default=None)
    ap.add_argument("--debug", action="store_true",
                    help="KEEP every captured frame on disk (off by "
                         "default; frames are otherwise never written)")
    ap.add_argument("--debug-dir", default=None)
    args = ap.parse_args(argv)

    debug_dir = None
    if args.debug:
        debug_dir = args.debug_dir or os.path.join(FB.DATA_DIR,
                                                   "FACE_SIGNIN_DEBUG")
        print(f"⚠ DEBUG: every captured frame will be written to "
              f"{debug_dir}")

    ENGINE = Engine(args.registered_dir, args.hr_map, debug_dir)
    ENGINE.load()
    if not ENGINE.gallery:
        print("⚠ no employee is usable for face sign-in yet. Link folders "
              "with --link-employee and check --hr-map-status.")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"face service on http://{args.host}:{args.port}  "
          f"(POST /verify, /reset, /reload;  GET /health)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
