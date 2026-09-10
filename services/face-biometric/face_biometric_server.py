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
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# Windows consoles default to cp1252, which cannot encode the characters used
# in this file's own status lines — the engine loaded its model fine and then
# died printing a warning about the gallery. Status output must never be able
# to kill the service, so the streams are widened before anything prints.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import face_biometric as FB
import face_biometric_service as SVC

DEFAULT_PORT = 5001

# Shared secret with the Node API. Empty means "no key", which is only
# allowed while bound to loopback — see main(). When set, EVERY request must
# carry it in X-Face-Key, /health included: health lists the gallery, and the
# gallery is a list of real employee IDs.
ENGINE_KEY = os.environ.get("FACE_ENGINE_KEY", "").strip()

_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_loopback(host):
    return str(host).strip().lower() in _LOOPBACK_HOSTS


# ---------------------------------------------------------------------------
# BROWSER AUTHORISATION
#
# The engine is reachable from the internet on one hostname and one path,
# through the Cloudflare tunnel. It still binds loopback only; the tunnel is
# the transport. That hostname is random, and a random hostname is obscurity,
# not authentication — so every public request must prove itself here.
#
# It cannot prove itself with FACE_ENGINE_KEY. That key is the backend's, it
# never expires, and it authorises everything including enrolment; putting it
# in a browser would publish the ability to enrol a stranger as an employee.
#
# So a browser carries a SEPARATE, short-lived, scoped token minted by the
# backend and verified here independently. Independently is the point: the
# backend deciding a request is fine is not a control the engine has applied,
# and the engine is the thing on the public hostname.
#
# The token is deliberately small: a signed JSON payload, HMAC-SHA256, base64url,
# no library. hmac and base64 are in the standard library, so this adds nothing
# to the dependency set that a model server has to carry.
# ---------------------------------------------------------------------------

# Signing key for browser tokens. NOT the engine key: a flaw in token handling
# must not be able to leak the credential that authorises enrolment.
BROWSER_TOKEN_SECRET = os.environ.get("FACE_BROWSER_TOKEN_SECRET", "").strip()

# The audience this engine will accept. A token minted for anything else — a
# different service, a different environment — is not for us.
TOKEN_AUDIENCE = "face-engine"

# What a browser token may ever authorise, whatever its claims say.
#
# An allowlist of (method, path), not a rule derived from the token. A token is
# an attacker-influenced document: if the set of permitted paths came out of it,
# a forged or mis-minted `act` would decide its own permissions. /verify runs
# recognition and returns a decision. Everything else either enrols a face,
# deletes state, or lists the gallery, and none of those is a browser's
# business at any expiry.
BROWSER_ALLOWED = {("POST", "/verify")}

# Origins allowed to make a cross-origin request, exactly. Comma-separated,
# from the environment, so adding the employee app later is configuration and
# not a code change. Never "*": these requests carry a biometric frame and an
# authorisation token, and a wildcard would let any page on the internet spend
# this machine's CPU on inference.
ALLOWED_ORIGINS = tuple(
    o.strip() for o in os.environ.get("FACE_ALLOWED_ORIGINS", "").split(",") if o.strip()
)

# How long a browser token is good for. The sign-in page asks for one when it
# starts capturing and streams frames for a few seconds; two minutes covers a
# slow camera and a retry without leaving a usable token lying in a log.
MAX_TOKEN_LIFETIME_SEC = 120
# A clock that is a little ahead should not reject its own fresh token.
CLOCK_SKEW_SEC = 30

# Public request budget, per session. The legitimate page sends a few frames a
# second; MIN_FRAME_INTERVAL_SEC already paces one session's captures. This is
# the coarser limit that stops a token being replayed as a CPU tap: inference
# is the expensive thing on this box, and it is what a public endpoint invites.
PUBLIC_RATE_WINDOW_SEC = 10.0
PUBLIC_RATE_MAX_REQUESTS = 60          # ~6/s sustained, far above a real capture
PUBLIC_BURST_MAX = 20


def _b64url_decode(s):
    """base64url without padding, as the token is written."""
    s = str(s)
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class _BrowserTokens:
    """Verification, replay tracking and rate limiting for browser tokens.

    Kept in one object because all three answer the same question — may this
    request run inference — and splitting them invites a caller that checks two
    of the three.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._seen = {}        # jti -> expiry, so a token cannot outlive itself
        self._hits = {}        # session id -> [timestamps]

    # -- verification -------------------------------------------------------
    def verify(self, token, method, path):
        """(claims, None) when the token authorises this exact request.

        Returns (None, reason) otherwise. `reason` is a fixed short string: it
        goes back over the internet, so it must not describe which claim failed
        in a way that helps somebody assemble a working one.
        """
        if not BROWSER_TOKEN_SECRET:
            # No signing key configured means browser tokens were never set up.
            # Refusing is the only safe reading: accepting would make the public
            # path open the moment somebody forgot a variable.
            return None, "unauthorised"
        if not token or len(token) > 4096:
            return None, "unauthorised"

        parts = token.split(".")
        if len(parts) != 2:
            return None, "unauthorised"
        payload_b64, sig_b64 = parts

        try:
            expected = hmac.new(BROWSER_TOKEN_SECRET.encode("utf-8"),
                                payload_b64.encode("ascii"), hashlib.sha256).digest()
            got = _b64url_decode(sig_b64)
        except (binascii.Error, ValueError, UnicodeEncodeError):
            return None, "unauthorised"
        # compare_digest so a signature cannot be found one byte at a time.
        if not hmac.compare_digest(expected, got):
            return None, "unauthorised"

        try:
            claims = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        except (binascii.Error, ValueError, UnicodeDecodeError):
            return None, "unauthorised"
        if not isinstance(claims, dict):
            return None, "unauthorised"

        # A valid signature only proves the backend wrote it. What it PERMITS
        # is a separate question, and every part of it is checked.
        if claims.get("aud") != TOKEN_AUDIENCE:
            return None, "forbidden"

        now = time.time()
        try:
            iat = float(claims.get("iat", 0))
            exp = float(claims.get("exp", 0))
        except (TypeError, ValueError):
            return None, "unauthorised"
        if exp <= now:
            return None, "expired"
        if iat > now + CLOCK_SKEW_SEC:
            return None, "unauthorised"
        # A token minted with a long life is refused even though it is signed:
        # the lifetime is part of the contract, not a suggestion the minter can
        # opt out of.
        if exp - iat > MAX_TOKEN_LIFETIME_SEC + CLOCK_SKEW_SEC:
            return None, "forbidden"

        sid = str(claims.get("sid") or "")
        if not sid or len(sid) > 128:
            return None, "forbidden"

        act = claims.get("act")
        acts = act if isinstance(act, list) else [act]
        if (method, path) not in BROWSER_ALLOWED or "verify" not in acts:
            return None, "forbidden"

        jti = str(claims.get("jti") or "")
        if not jti or len(jti) > 128:
            return None, "forbidden"
        with self._lock:
            self._sweep(now)
            # NOT single-use: a sign-in streams several frames under one token,
            # and a token consumed by the first frame would break the flow it
            # exists for. What replay is bounded by is the expiry and the rate
            # limit below — a captured token is worth at most a few seconds of
            # inference against one session.
            self._seen[jti] = exp
        return claims, None

    # -- rate limiting ------------------------------------------------------
    def allow(self, sid):
        """False when this session has asked for too much, too fast."""
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(sid, ()) if now - t < PUBLIC_RATE_WINDOW_SEC]
            if len(hits) >= PUBLIC_RATE_MAX_REQUESTS:
                self._hits[sid] = hits
                return False
            recent = [t for t in hits if now - t < 1.0]
            if len(recent) >= PUBLIC_BURST_MAX:
                self._hits[sid] = hits
                return False
            hits.append(now)
            self._hits[sid] = hits
            if len(self._hits) > 4000:
                self._hits = {k: v for k, v in self._hits.items()
                              if v and now - v[-1] < PUBLIC_RATE_WINDOW_SEC}
            return True

    def _sweep(self, now):
        if len(self._seen) < 4000:
            return
        self._seen = {k: v for k, v in self._seen.items() if v > now}


BROWSER = _BrowserTokens()
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
        # A second, leaner model used ONLY by verify(). Registration keeps the
        # full-size detector; sign-in runs several times a second and pays for
        # its detector on every frame. See FB.build_live_face_app.
        self.live_app = None
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

    def get_live_app(self):
        """The lean model used by /verify, built on first use.

        It used to load at boot beside the registration model. Face SIGN-IN has
        since been removed from the CMS, so on a server that only registers
        faces — which is every deployment now — that was a second ~300MB model
        held for a request that never arrives. Memory is the binding constraint
        on a small host, so it is paid for only when something actually calls
        /verify (the CLI kiosk path).
        """
        if self.live_app is None:
            self.live_app = FB.build_live_face_app(verbose=True)
            # The first inference pays for lazily-allocated arenas and thread
            # pools — roughly twice the steady-state cost. Spend it here rather
            # than on the person standing at the camera.
            try:
                import numpy as _np
                self.live_app.get(_np.zeros((360, 640, 3), dtype=_np.uint8))
            except Exception:
                pass
        return self.live_app

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
            # The live model, not the registration one. Built on first use.
            faces = self.get_live_app().get(img)
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

    def _allowed_origin(self):
        """The request's Origin, if it is one we serve. Never a wildcard.

        Returned rather than compared in place so the SAME value is echoed
        back: replying with a wildcard, or with an origin we did not check,
        would let any page on the internet read a biometric decision.
        """
        origin = self.headers.get("Origin")
        if origin and origin in ALLOWED_ORIGINS:
            return origin
        return None

    def _cors_headers(self):
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        # Sent whether or not this request matched, so a cache cannot serve one
        # origin's response to another.
        self.send_header("Vary", "Origin")

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # This engine answers a public hostname on one path. Nothing it returns
        # should ever be framed, sniffed into another type, or referred onward.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """CORS preflight.

        Only for an origin on the list and only for what a browser is allowed
        to do here. An unknown origin gets 403 with no CORS headers, which is
        what makes the browser refuse the real request that would follow.
        """
        origin = self._allowed_origin()
        path = self.path.rstrip("/")
        if not origin or ("POST", path) not in BROWSER_ALLOWED:
            return self._json(403, {"ok": False, "error": "forbidden"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        # Exactly what the sign-in page sends. Not a wildcard: the header list
        # is part of the contract, and widening it later should be deliberate.
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        # No Access-Control-Allow-Credentials. The token travels in a header,
        # not a cookie, so the browser never needs to attach ambient
        # authority — and asking for credentials would make an origin mistake
        # far more dangerous than it already is.
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _authorised(self):
        """True when the caller proved it is the Node API.

        No key configured means the service is on loopback (main() refuses
        any other binding without one), where the OS is the boundary.
        """
        if not ENGINE_KEY:
            return True
        got = self.headers.get("X-Face-Key") or ""
        # compare_digest so a wrong key cannot be found one byte at a time.
        return hmac.compare_digest(got, ENGINE_KEY)

    def _authorise(self, method, path):
        """Decide who this is and whether they may do this, before anything costs.

        Two callers exist and they are not equivalent:

          the Node API   proves itself with X-Face-Key and may do everything.
          a browser      proves itself with a short-lived scoped token and may
                         do exactly one thing.

        Returns (kind, sid, None) or (None, None, (code, error)). The checks run
        cheapest-and-most-decisive first — signature before claims, claims
        before rate limit, all of it before a single byte of the body is read —
        because the body is a photograph and the work after it is model
        inference. An unauthorised request must never be able to spend that.
        """
        key = self.headers.get("X-Face-Key")
        if key is not None:
            if ENGINE_KEY and hmac.compare_digest(key, ENGINE_KEY):
                return "engine", None, None
            return None, None, (401, "unauthorised")

        auth = self.headers.get("Authorization") or ""
        if auth[:7].lower() == "bearer ":
            claims, reason = BROWSER.verify(auth[7:].strip(), method, path)
            if reason:
                return None, None, (403 if reason == "forbidden" else 401, reason)
            sid = str(claims.get("sid"))
            if not BROWSER.allow(sid):
                return None, None, (429, "rate_limited")
            return "browser", sid, None

        # No credential at all. On loopback with no key configured the OS is
        # the boundary and the Node API is the only caller — that is the
        # development case main() allows. Otherwise this is a refusal.
        if not ENGINE_KEY:
            return "engine", None, None
        return None, None, (401, "unauthorised")

    def do_GET(self):
        # X-Face-Key only, deliberately. /health lists the gallery — every
        # enrolled employee's biometric id — so it is not something a browser
        # token may reach at any expiry, and the public hostname does not route
        # it either. Two independent refusals for the same fact.
        if not self._authorised():
            return self._json(401, {"ok": False, "error": "unauthorised"})
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

        # ORDER MATTERS, and this is the order.
        #
        #   1. what path is this            — an unknown path costs nothing
        #   2. who is this, and may they    — signature, then claims, then rate
        #   3. how big is the body          — refused by header, before reading
        #   4. read and parse               — first time we touch attacker bytes
        #   5. decode the image, infer      — the expensive part
        #
        # Inference is the only genuinely costly thing here, and a public
        # endpoint is an invitation to spend it. Nothing above step 5 is
        # reachable without a valid, unexpired, correctly scoped token.
        kind, browser_sid, refusal = self._authorise("POST", path)
        if refusal:
            code, error = refusal
            return self._json(code, {"ok": False, "error": error})

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
            #
            # The connection is closed rather than kept alive, because the
            # sender is still writing a body nobody will consume. Draining it
            # to be polite would be doing the work we just refused; leaving the
            # socket open would hold a connection for a client that has been
            # told no. A client mid-upload sees the reset — which is the
            # honest outcome of a refusal that happens before the transfer
            # finishes.
            self.close_connection = True
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

            # QUICK MODE — judge ONLY what was just written.
            #
            # The full path below re-embeds the entire gallery twice (once to
            # reload it, once to build the report). HR uploading twenty photos
            # in one go pays that once and it is fine. Self-registration sends
            # ONE photo at a time, so the same work is paid per photo, and it
            # grows with the gallery: at 200 enrolled employees a single
            # snapshot means thousands of CPU embeddings, the request passes
            # the API's timeout, and the phone is told the service is
            # unreachable while the engine is busy and healthy.
            #
            # One photo needs one embedding to answer "was that usable?".
            # The whole-gallery recompute is deferred to /register/finalise,
            # which the enrolment flow calls once at the end.
            # Judge each photo that was just written, on BOTH paths. One
            # embedding per new photo is cheap next to anything else here, and
            # it is what the API stores so other systems can recognise this
            # person without holding the photograph. Doing it only on the quick
            # path meant a phone upload produced an embedding and an HR upload
            # did not.
            #
            # Same fallback save_registration_photos applies: the engine carries
            # None when it was not given an explicit directory.
            reg_root = ENGINE.registered_dir or FB.REGISTERED_PEOPLE_DIR
            verdicts, accepted_now = [], 0
            for item in res["saved"]:
                photo = os.path.join(reg_root, res["folder"], item["filename"])
                rec = FB.analyse_photo(ENGINE.app, photo)
                if rec["accepted"]:
                    accepted_now += 1
                emb = rec.get("embedding")
                verdicts.append({"filename": item["filename"],
                                 "accepted": bool(rec["accepted"]),
                                 "role": rec["role"],
                                 "reason": rec["reason"],
                                 "embedding": ([float(x) for x in emb]
                                               if emb is not None else None),
                                 "model": FB.FACE_MODEL_NAME})

            if payload.get("quick"):
                # Stop here: no gallery reload, no whole-folder report.
                return self._json(200, {"ok": True, **res, "quick": True,
                                        "verdicts": verdicts,
                                        "accepted_now": accepted_now,
                                        "status": None})

            # A gallery that changed on disk is stale in memory. Reloading
            # here is what makes the status the operator sees after an
            # upload the status the operator sees.
            ENGINE.reload_gallery()
            report = SVC.employee_registration_report(
                res["folder"], ENGINE.registered_dir, ENGINE.hr_map,
                app=ENGINE.app)
            return self._json(200, {"ok": True, **res, "status": report,
                                    "verdicts": verdicts,
                                    "accepted_now": accepted_now})

        if path == "/register/finalise":
            # The expensive half of an upload, once, at the end of a
            # self-registration: reload the sign-in gallery so the employee
            # can actually be recognised, then report their readiness.
            folder = payload.get("folder")
            if not folder:
                return self._json(400, {"ok": False, "error": "missing_folder"})
            ENGINE.reload_gallery()
            # reload_gallery already embedded every photo on disk. Handing that
            # result to the report is the difference between one pass over the
            # gallery and two.
            report = SVC.employee_registration_report(
                folder, ENGINE.registered_dir, ENGINE.hr_map, app=ENGINE.app,
                preloaded=(ENGINE.folder_gallery, ENGINE.report))
            if report is None:
                return self._json(404, {"ok": False,
                                        "error": "folder_not_found"})
            return self._json(200, {"ok": True, "status": report,
                                    "gallery_size": len(ENGINE.gallery)})

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
            # The whole picture, from the gallery this process already holds.
            #
            # This used to recompute from disk on every call, which means one
            # embedding per registration photo: measured at 19-40s for a SINGLE
            # employee with six photos, against the API's 20s budget — so the
            # HR page reported "the face service is not running" while the
            # service was running and merely thinking. With a real roster it
            # would be minutes.
            #
            # The engine already loaded exactly this at boot and reloads it
            # whenever the gallery changes (upload, archive, finalise), so the
            # recompute was redundant as well as slow. generated_at is set to
            # when that load happened, not to now — a cached answer that claims
            # to be live is worse than a slow one.
            if payload.get("refresh"):
                # The explicit "recheck" path, for when photos reached the
                # folder by some route this process did not see.
                ENGINE.reload_gallery()
            snap = SVC.status_snapshot(
                ENGINE.registered_dir, ENGINE.hr_map, app=ENGINE.app,
                preloaded=(ENGINE.folder_gallery, ENGINE.report))
            snap["generated_at"] = ENGINE.loaded_at
            return self._json(200, {"ok": True, "snapshot": snap})

        if path == "/register/embed":
            # The embedding for a photo already on disk, so registrations made
            # before the API started storing them can be filled in without
            # asking anybody to sit for their photograph again. Reads one file
            # and returns numbers; writes nothing.
            folder = payload.get("folder")
            filename = payload.get("filename")
            if not folder or not filename:
                return self._json(400, {"ok": False, "error": "missing_target"})
            safe, why = SVC.safe_image_name(filename, 0)
            if not safe or SVC.safe_folder_name(folder) != folder:
                return self._json(400, {"ok": False, "error": why or "bad_target"})
            reg_root = ENGINE.registered_dir or FB.REGISTERED_PEOPLE_DIR
            photo = os.path.join(reg_root, folder, filename)
            if not os.path.isfile(photo):
                return self._json(404, {"ok": False, "error": "not_found"})
            rec = FB.analyse_photo(ENGINE.app, photo)
            emb = rec.get("embedding")
            return self._json(200, {
                "ok": True,
                "filename": filename,
                "accepted": bool(rec["accepted"]),
                "reason": rec["reason"],
                "embedding": ([float(x) for x in emb]
                              if emb is not None else None),
                "model": FB.FACE_MODEL_NAME,
            })

        if path == "/register/photo":
            data, why = SVC.read_registration_photo(
                payload.get("folder"), payload.get("filename"),
                registered_dir=ENGINE.registered_dir)
            if data is None:
                return self._json(400, {"ok": False, "error": why})
            return self._json(200, {"ok": True, "image": data})

        if path == "/register/status":
            # Same economics as /register/snapshot: served from the gallery in
            # memory unless the caller explicitly asks for a re-read. HR's
            # "recheck" button is that caller, and is the one place where
            # paying for a full pass is the whole point.
            folder = payload.get("folder")
            if payload.get("refresh"):
                ENGINE.reload_gallery()
            report = SVC.employee_registration_report(
                folder, ENGINE.registered_dir, ENGINE.hr_map,
                app=ENGINE.app,
                preloaded=(ENGINE.folder_gallery, ENGINE.report))
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
                    help="default 127.0.0.1. Any other binding requires "
                         "FACE_ENGINE_KEY to be set")
    ap.add_argument("--key", default=None,
                    help="shared secret the Node API must send in "
                         "X-Face-Key. Prefer the FACE_ENGINE_KEY env var; "
                         "an argument is visible in the process list")
    ap.add_argument("--registered-dir", default=None)
    ap.add_argument("--hr-map", default=None)
    ap.add_argument("--debug", action="store_true",
                    help="KEEP every captured frame on disk (off by "
                         "default; frames are otherwise never written)")
    ap.add_argument("--debug-dir", default=None)
    args = ap.parse_args(argv)

    global ENGINE_KEY
    if args.key:
        ENGINE_KEY = args.key.strip()

    # THE INTERLOCK. Binding anywhere but loopback puts the gallery, the
    # upload path and /verify on a network. Without a key that is an open
    # endpoint that will happily enrol a stranger's face as an employee, and
    # /health hands out every biometric ID before they even try. Refusing to
    # start is the only behaviour that cannot be got wrong by forgetting a
    # variable.
    if not _is_loopback(args.host) and not ENGINE_KEY:
        print(f"refusing to bind {args.host} with no key. "
              f"Set FACE_ENGINE_KEY (the same value as the backend's) and "
              f"restart. On loopback no key is needed.", file=sys.stderr)
        return 2

    if ENGINE_KEY and len(ENGINE_KEY) < 24:
        print("⚠ FACE_ENGINE_KEY is short. Use 32+ random characters: "
              "`openssl rand -base64 32`.", file=sys.stderr)

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
          f"(POST /verify, /reset, /reload;  GET /health)  "
          f"auth={'key' if ENGINE_KEY else 'loopback-only'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
