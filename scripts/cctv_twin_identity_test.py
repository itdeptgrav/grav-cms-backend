import pickle
import tempfile
import unittest
from types import SimpleNamespace

import numpy as np

from cctv_twin_identity import FaceIdentityTracker, load_trusted_gallery, match_embedding


class FakeAnalyzer:
    def __init__(self, faces):
        self.faces = faces

    def get(self, _frame):
        return self.faces


class IdentityTests(unittest.TestCase):
    def test_gallery_loads_only_ready_trusted_people(self):
        data = {
            "persons": {"Ready": [np.array([1.0, 0.0])], "Weak": [np.array([0.0, 1.0])]},
            "registered": {
                "Ready": {"trusted_for_live": True, "readiness": "READY"},
                "Weak": {"trusted_for_live": False, "readiness": "WEAK_NEEDS_MORE_PHOTOS"},
            },
        }
        with tempfile.NamedTemporaryFile() as handle:
            pickle.dump(data, handle)
            handle.flush()
            gallery = load_trusted_gallery(handle.name)
        self.assertEqual(list(gallery), ["Ready"])

    def test_match_requires_both_distance_and_person_margin(self):
        gallery = {"A": [np.array([1.0, 0.0])], "B": [np.array([0.8, 0.6])]}
        self.assertEqual(match_embedding(np.array([1.0, 0.0]), gallery)["name"], "A")
        ambiguous = {"A": [np.array([1.0, 0.0])], "B": [np.array([0.998, 0.063]) ]}
        self.assertIsNone(match_embedding(np.array([1.0, 0.0]), ambiguous))

    def test_two_direct_hits_confirm_and_missing_face_holds_briefly(self):
        data = {
            "persons": {"Ready": [np.array([1.0, 0.0])]},
            "registered": {"Ready": {"trusted_for_live": True, "readiness": "READY"}},
        }
        face = SimpleNamespace(
            bbox=np.array([20, 20, 90, 90]), det_score=0.9, pose=np.array([0, 0, 0]),
            normed_embedding=np.array([1.0, 0.0]),
        )
        with tempfile.NamedTemporaryFile() as handle:
            pickle.dump(data, handle)
            handle.flush()
            tracker = FaceIdentityTracker(handle.name, analyzer=FakeAnalyzer([face]), hold_seconds=5)
        boxes = {"7": [0, 0, 200, 300]}
        self.assertEqual(tracker.update(np.zeros((10, 10, 3)), boxes, now=1), {})
        confirmed = tracker.update(np.zeros((10, 10, 3)), boxes, now=2)
        self.assertEqual(confirmed["7"]["displayName"], "Ready")
        tracker.analyzer.faces = []
        self.assertIn("7", tracker.update(np.zeros((10, 10, 3)), boxes, now=5))
        self.assertEqual(tracker.update(np.zeros((10, 10, 3)), boxes, now=8), {})


if __name__ == "__main__":
    unittest.main()
