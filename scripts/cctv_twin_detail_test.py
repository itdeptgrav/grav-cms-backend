"""Tests for cctv_twin_detail.DetailStills against a local HTTP server.

Run:  python3 scripts/cctv_twin_detail_test.py
"""
import http.server
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cctv_twin_detail import DetailStills, scale_box, snapshot_url  # noqa: E402

REPLY = {}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        REPLY["path"] = self.path
        status, headers, body = REPLY["next"]
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class DetailStillsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def stills(self, t=None):
        clock = (lambda: t[0]) if t else None
        kwargs = {"clock": clock} if clock else {}
        return DetailStills(snapshot_url(self.base, 21, "k&y"), interval=15, timeout=5, **kwargs)

    def test_a_live_original_still_is_taken_once(self):
        REPLY["next"] = (200, {"X-Frame-State": "live", "X-Frame-Size": "1280x720", "Content-Type": "image/jpeg"}, b"JPEG")
        s = self.stills()
        self.assertEqual(s.fetch_once(), 15)
        self.assertEqual(REPLY["path"], "/snapshot/21?key=k%26y&quality=original")
        body, size, _ = s.take()
        self.assertEqual((body, size), (b"JPEG", (1280, 720)))
        self.assertIsNone(s.take(), "each still is handed over once")
        self.assertTrue(s.supported)
        self.assertTrue(s.active())

    def test_an_older_server_standard_snapshot_is_never_used(self):
        REPLY["next"] = (200, {"Content-Type": "image/jpeg"}, b"STANDARD")
        s = self.stills()
        self.assertGreaterEqual(s.fetch_once(), 300, "backs off")
        self.assertIsNone(s.take())
        self.assertFalse(s.supported)
        self.assertFalse(s.active())

    def test_unavailable_waits_and_hands_over_nothing(self):
        REPLY["next"] = (503, {"Retry-After": "20"}, b"original not available")
        s = self.stills()
        self.assertEqual(s.fetch_once(), 20)
        self.assertIsNone(s.take())

    def test_stills_stop_counting_as_active_when_they_stop_arriving(self):
        t = [100.0]
        REPLY["next"] = (200, {"X-Frame-State": "live", "X-Frame-Size": "1280x720"}, b"J")
        s = self.stills(t)
        s.fetch_once()
        t[0] = 140.0
        self.assertTrue(s.active())
        t[0] = 150.0
        self.assertFalse(s.active(), "more than three intervals without a still")

    def test_boxes_scale_back_to_the_stream_frame(self):
        self.assertEqual(scale_box((640, 360, 1280, 720), (1280, 720), (640, 360)), (320.0, 180.0, 640.0, 360.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
