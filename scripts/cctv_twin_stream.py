"""The CCTV app's MJPEG stream, read frame by frame at each frame's own size.

cv2.VideoCapture on an MJPEG URL fixes the picture size at the first frame and
rescales every later frame to it. The CCTV app's Original stream starts with a
few 640x360 Standard frames labelled "switching to Original" before the
1280x720 main-stream frames, so through OpenCV the worker silently got
640x360 for the whole run. This reader parses the multipart stream itself,
decodes each JPEG with cv2.imdecode, and uses the app's per-part
X-Frame-State header (live | standard | cached | status) to skip stand-ins.

Only the newest frame is kept (a background thread drains the connection), so
the worker never processes a backlog when inference is slower than the stream.
The interface mirrors cv2.VideoCapture: isOpened(), read(), release().
"""
import ssl
import threading
import time
import urllib.error
import urllib.request

import cv2
import numpy as np


def _tls_context():
    """Verified TLS with certifi's CA bundle when present: python.org builds on
    macOS ship without a system certificate store."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def iter_parts(stream):
    """(state, jpeg bytes) for each part of a multipart/x-mixed-replace body."""
    while True:
        line = stream.readline()
        if not line:
            return
        if not line.startswith(b"--"):
            continue
        headers = {}
        while True:
            header = stream.readline()
            if not header:
                return
            header = header.strip()
            if not header:
                break
            key, _, value = header.partition(b":")
            headers[key.strip().lower()] = value.strip()
        try:
            length = int(headers.get(b"content-length", b"0") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            continue
        body = stream.read(length)
        if body is None or len(body) < length:
            return
        yield headers.get(b"x-frame-state", b"").decode("ascii", "replace").lower(), body


class MjpegReader:
    """Newest live frame of an MJPEG URL, decoded at its native size.

    Accepts parts marked "live" (or unmarked, for other servers). A labelled
    Standard stand-in ("standard") is used only after `standin_after_s`
    without any live frame, so a camera whose Original fails still shows
    people rather than nothing; status cards and cached pictures never are.
    """

    def __init__(self, url, timeout=10.0, standin_after_s=10.0, read_wait_s=2.0):
        self.url, self.timeout = url, timeout
        self.standin_after_s, self.read_wait_s = standin_after_s, read_wait_s
        self._cond = threading.Condition()
        self._latest = None  # (serial, jpeg, state)
        self._serial = 0
        self._taken = 0
        self._last_live = None
        self._tls = _tls_context()
        self._stop = threading.Event()
        self._opened = threading.Event()
        self._failed = threading.Event()
        self.state = None
        self.counts = {}
        self._thread = threading.Thread(target=self._run, name="mjpeg-reader", daemon=True)

    def start(self, wait_s=15.0):
        self._thread.start()
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline and not (self._opened.is_set() or self._failed.is_set()):
            time.sleep(0.05)
        return self

    def isOpened(self):  # noqa: N802 (cv2.VideoCapture interface)
        return self._opened.is_set() and not self._stop.is_set()

    def _accept(self, state, now):
        if state in ("live", ""):
            self._last_live = now
            return True
        if state == "standard":
            since = self._last_live if self._last_live is not None else self._started
            return now - since >= self.standin_after_s
        return False

    def _run(self):
        self._started = time.monotonic()
        backoff = 1.0
        while not self._stop.is_set():
            try:
                # http.client's response reads a line or an exact length as soon
                # as it has arrived (and undoes chunked encoding, which a proxy
                # may add); a large read-ahead buffer would hold a frame's tail
                # back until the next frame's bytes arrived.
                request = urllib.request.Request(self.url, headers={"User-Agent": "grav-twin-worker"})
                with urllib.request.urlopen(request, timeout=self.timeout, context=self._tls) as response:
                    self._opened.set()
                    backoff = 1.0
                    for state, jpeg in iter_parts(response):
                        if self._stop.is_set():
                            return
                        now = time.monotonic()
                        self.counts[state or "unmarked"] = self.counts.get(state or "unmarked", 0) + 1
                        if not self._accept(state, now):
                            continue
                        with self._cond:
                            self._serial += 1
                            self._latest = (self._serial, jpeg, state or "live")
                            self._cond.notify_all()
            except (urllib.error.URLError, OSError, ValueError):
                if not self._opened.is_set():
                    self._failed.set()
            if self._stop.wait(backoff):
                return
            backoff = min(10.0, backoff * 2)

    def read(self):
        """(True, frame) for a frame newer than the last one read, else (False, None)."""
        with self._cond:
            if not self._cond.wait_for(lambda: self._latest and self._latest[0] > self._taken or self._stop.is_set(),
                                       timeout=self.read_wait_s):
                return False, None
            if self._stop.is_set():
                return False, None
            serial, jpeg, state = self._latest
            self._taken = serial
        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return False, None
        self.state = state
        return True, frame

    def release(self):
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
