"""Tests for cctv_twin_stream.MjpegReader against a local multipart server.

Run:  ~/phone_detc_venv/bin/python scripts/cctv_twin_stream_test.py
"""
import http.server
import os
import sys
import threading
import time
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cctv_twin_stream import MjpegReader  # noqa: E402


def jpeg(w, h):
    ok, buf = cv2.imencode(".jpg", np.zeros((h, w, 3), dtype=np.uint8))
    assert ok
    return buf.tobytes()


PLAN = {}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            for state, body, pause in PLAN["parts"]:
                head = b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(body)).encode()
                if state is not None:
                    head += b"\r\nX-Frame-State: " + state.encode()
                self.wfile.write(head + b"\r\n\r\n" + body + b"\r\n")
                self.wfile.flush()
                time.sleep(pause)
            time.sleep(PLAN.get("hold", 0.5))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):
        pass


class MjpegReaderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/stream/21"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_original_frames_keep_their_size_after_a_smaller_stand_in(self):
        PLAN["parts"] = [("standard", jpeg(640, 360), 0.05), ("standard", jpeg(640, 360), 0.05),
                         ("live", jpeg(1280, 720), 0.05), ("live", jpeg(1280, 720), 0.05)]
        reader = MjpegReader(self.url, standin_after_s=10).start()
        try:
            self.assertTrue(reader.isOpened())
            ok, frame = reader.read()
            self.assertTrue(ok)
            self.assertEqual(frame.shape[:2], (720, 1280), "the live frame at its own size, not the stand-in's")
            self.assertEqual(reader.state, "live")
        finally:
            reader.release()

    def test_status_cards_and_cached_pictures_are_never_used(self):
        PLAN["parts"] = [("status", jpeg(640, 360), 0.05), ("cached", jpeg(640, 360), 0.05)]
        reader = MjpegReader(self.url, read_wait_s=0.5).start()
        try:
            self.assertEqual(reader.read(), (False, None))
            time.sleep(0.2)
            self.assertEqual(reader.counts.get("status"), 1)
        finally:
            reader.release()

    def test_a_stand_in_is_used_only_when_no_live_frame_comes(self):
        PLAN["parts"] = [("standard", jpeg(640, 360), 0.05)] * 6
        reader = MjpegReader(self.url, standin_after_s=0.1, read_wait_s=1.0).start()
        try:
            ok, frame = reader.read()
            self.assertTrue(ok)
            self.assertEqual(frame.shape[:2], (360, 640))
            self.assertEqual(reader.state, "standard")
        finally:
            reader.release()

    def test_only_the_newest_frame_is_handed_over(self):
        PLAN["parts"] = [("live", jpeg(320, 180), 0.0), ("live", jpeg(640, 360), 0.0), ("live", jpeg(1280, 720), 0.0)]
        PLAN["hold"] = 3.0  # keep the connection open: no reconnect within the test
        reader = MjpegReader(self.url, read_wait_s=0.5).start()
        try:
            time.sleep(0.3)
            ok, frame = reader.read()
            self.assertTrue(ok)
            self.assertEqual(frame.shape[:2], (720, 1280))
            self.assertEqual(reader.read()[0], False, "no stale backlog")
        finally:
            reader.release()
            PLAN["hold"] = 0.5

    def test_unmarked_parts_from_other_servers_are_accepted(self):
        PLAN["parts"] = [(None, jpeg(800, 450), 0.05)]
        reader = MjpegReader(self.url).start()
        try:
            ok, frame = reader.read()
            self.assertTrue(ok)
            self.assertEqual(frame.shape[:2], (450, 800))
        finally:
            reader.release()


if __name__ == "__main__":
    unittest.main(verbosity=2)
