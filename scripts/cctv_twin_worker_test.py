"""Tests for helpers in cctv-twin-person-worker.py (loaded by path).

Run:  ~/phone_detc_venv/bin/python scripts/cctv_twin_worker_test.py
"""
import importlib.util
import os
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location("person_worker", os.path.join(HERE, "cctv-twin-person-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

from cctv_twin_pose import ObjectConfirmer  # noqa: E402


class WorkerHelpersTest(unittest.TestCase):
    def test_a_phone_in_hand_is_not_also_a_loose_phone(self):
        objects = [{"type": "PHONE", "box": (492, 249, 522, 275)}, {"type": "PHONE", "box": (810, 357, 876, 385)},
                   {"type": "LAPTOP", "box": (480, 240, 530, 280)}]
        kept = worker.drop_held_phones(objects, [(492, 249, 521, 275)])
        self.assertEqual([o["box"] for o in kept], [(810, 357, 876, 385), (480, 240, 530, 280)])

    def test_a_neighbour_missing_for_a_frame_is_held_but_a_replacement_is_not(self):
        # Two people side by side (boxes overlap), both seen since t=0.
        held = {"a": (10.0, {"id": "a"}, (100, 100, 200, 300), 7), "b": (10.4, {"id": "b"}, (180, 120, 280, 300), 8)}
        first = {"a": 0.0, "b": 0.0}
        kept = worker.drop_replaced(held, 8, first)  # "a" missed this frame
        self.assertIn("a", kept, "the neighbour beside it is not a reason to drop it")
        # A new id at a's place, first seen after a was last seen: a replacement.
        held2 = {"a": (10.0, {"id": "a"}, (100, 100, 200, 300), 7), "c": (10.4, {"id": "c"}, (105, 100, 205, 300), 8)}
        self.assertNotIn("a", worker.drop_replaced(held2, 8, {"a": 0.0, "c": 10.2}))

    def test_face_matching_does_not_block_and_runs_one_at_a_time(self):
        gate = threading.Event()

        class SlowTracker:
            calls = 0

            def update(self, frame, boxes, now):
                SlowTracker.calls += 1
                gate.wait(2)
                return {key: {"status": "CONFIRMED_FACE"} for key in boxes}

        bg = worker.BackgroundIdentity(SlowTracker())
        started = time.perf_counter()
        self.assertTrue(bg.submit(None, {"1": (0, 0, 1, 1)}, 0.0))
        self.assertLess(time.perf_counter() - started, 0.1, "submit returns at once")
        self.assertFalse(bg.submit(None, {"1": (0, 0, 1, 1)}, 0.1), "one scan in flight")
        self.assertEqual(bg.current(), {})
        gate.set()
        for _ in range(100):
            if bg.current():
                break
            time.sleep(0.01)
        self.assertEqual(list(bg.current()), ["1"])
        self.assertEqual(SlowTracker.calls, 1)

    def test_objects_only_the_second_detector_sees_still_confirm(self):
        coco, world = ObjectConfirmer(need=3, window=5), ObjectConfirmer(need=2, window=3)
        laptop, bag = ("LAPTOP", 0.9, (10, 10, 60, 50)), ("HANDBAG", 0.5, (100, 10, 160, 50))
        for t in range(4):
            coco.update([laptop], float(t))
        world.update([bag, ("LAPTOP", 0.8, (11, 11, 61, 51))], 0.0)
        world.update([bag, ("LAPTOP", 0.8, (11, 11, 61, 51))], 6.0)
        merged = worker.merged_objects(coco, world)
        self.assertEqual(sorted(o["type"] for o in merged), ["HANDBAG", "LAPTOP"], "the laptop once, the bag from YOLO-World")
        self.assertTrue(any(o["id"].startswith("w-") for o in merged if o["type"] == "HANDBAG"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
