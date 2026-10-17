"""Occasional full-detail stills for the factory twin's object detector.

The person worker reads the camera's Standard stream continuously (people move;
tracking needs every frame). Desk objects do not move, and on NVR1 the Standard
picture is a 352x288 sub-stream stretched to 640x360 -- too coarse to see a
laptop. So objects are detected on one main-stream ("Original") picture every
few seconds instead, from the CCTV app's GET /snapshot/<i>?quality=original:
a 1280-wide live frame for ~1/15 of the bandwidth of streaming it.

Only a picture the server marks `X-Frame-State: live` is used. An older CCTV
server ignores `quality=` and returns its Standard picture without that header;
that is detected and the worker keeps its stream-frame object scans.
"""
import threading
import time
import urllib.parse

import requests

UNSUPPORTED_BACKOFF_S = 300.0  # re-check an older server every 5 minutes


def snapshot_url(cctv_url, stream_index, key):
    return f"{cctv_url.rstrip('/')}/snapshot/{int(stream_index)}?key={urllib.parse.quote(key)}&quality=original"


class DetailStills:
    """Fetch one Original still every `interval` seconds in a background thread.

    take() returns (jpeg_bytes, size, monotonic_time) once per new still, else
    None. active(now) is True while stills keep arriving, so the caller can
    choose between detail scans and its own fallback.
    """

    def __init__(self, url, interval=15.0, timeout=15.0, session=None, clock=time.monotonic):
        self.url, self.interval, self.timeout = url, max(1.0, float(interval)), timeout
        self.session = session or requests.Session()
        self.clock = clock
        self._lock = threading.Lock()
        self._new = None
        self.last_ok = None
        self.supported = None  # None = not known yet
        self.last_error = None
        self._stop = threading.Event()
        self._thread = None

    def fetch_once(self):
        """One request; returns the seconds to wait before the next."""
        try:
            response = self.session.get(self.url, timeout=self.timeout)
        except requests.RequestException as error:
            self.last_error = f"{type(error).__name__}"
            return self.interval
        if response.status_code == 503:
            self.last_error = "original not available"
            retry = response.headers.get("Retry-After")
            return max(self.interval, float(retry)) if retry and retry.isdigit() else self.interval
        if response.status_code != 200:
            self.last_error = f"HTTP {response.status_code}"
            return self.interval
        if response.headers.get("X-Frame-State") != "live" or not response.headers.get("X-Frame-Size"):
            # An older server answered with its Standard snapshot.
            self.supported = False
            self.last_error = "server has no Original snapshot"
            return UNSUPPORTED_BACKOFF_S
        try:
            w, h = (int(v) for v in response.headers["X-Frame-Size"].lower().split("x"))
        except ValueError:
            self.last_error = "bad X-Frame-Size"
            return self.interval
        self.supported = True
        self.last_error = None
        now = self.clock()
        with self._lock:
            self._new = (response.content, (w, h), now)
            self.last_ok = now
        return self.interval

    def take(self):
        with self._lock:
            item, self._new = self._new, None
        return item

    def active(self, now=None):
        now = self.clock() if now is None else now
        return self.last_ok is not None and now - self.last_ok <= 3 * self.interval

    def start(self):
        def loop():
            while not self._stop.is_set():
                started = self.clock()
                wait = self.fetch_once()
                self._stop.wait(max(0.0, wait - (self.clock() - started)))
        self._thread = threading.Thread(target=loop, name="detail-stills", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()


def scale_box(box, from_size, to_size):
    """A box in a detail still's pixels -> the stream frame's pixels (same view)."""
    sx = to_size[0] / float(from_size[0])
    sy = to_size[1] / float(from_size[1])
    x1, y1, x2, y2 = box
    return (x1 * sx, y1 * sy, x2 * sx, y2 * sy)
