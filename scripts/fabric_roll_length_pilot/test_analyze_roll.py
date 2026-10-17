import math
import unittest

import numpy as np

from analyze_roll import (
    Geometry,
    angle_mask,
    candidate_length_pixels,
    detect_profile_peaks,
    ellipse_perimeter,
    millimetres_per_pixel,
    sector_consistency_quality,
)
from estimate_from_diameter import (
    annulus_area_mm2,
    effective_pitch_from_known_length,
    length_from_area,
)


class FabricRollAnalysisTests(unittest.TestCase):
    def test_two_point_scale(self):
        self.assertAlmostEqual(millimetres_per_pixel((0, 0, 30, 40), 100), 2.0)

    def test_circle_perimeter(self):
        self.assertAlmostEqual(ellipse_perimeter(10, 10), 20 * math.pi)

    def test_wrapped_angle_exclusion(self):
        included = angle_mask(360, [(350, 10)])
        self.assertFalse(included[0])
        self.assertFalse(included[355])
        self.assertTrue(included[180])

    def test_peak_detection_respects_spacing(self):
        profile = np.zeros(80, dtype=np.float32)
        profile[[10, 12, 30, 55]] = [8, 7, 9, 10]
        peaks = detect_profile_peaks(profile, min_spacing=5, threshold_mad=0.5)
        self.assertEqual(len(peaks), 3)
        self.assertLessEqual(abs(peaks[0] - 10), 1)
        self.assertEqual(peaks[1:], [30, 55])

    def test_candidate_length_uses_each_radius(self):
        geometry = Geometry(100, 100, 50, 50, 0.0)
        total = candidate_length_pixels([25, 50], 101, geometry)
        expected = 2 * math.pi * (12.5 + 25.0)
        self.assertAlmostEqual(total, expected)

    def test_sector_consistency_rejects_disagreement(self):
        quality, evidence = sector_consistency_quality(
            [
                {"count": 10, "lengthPixels": 1000},
                {"count": 18, "lengthPixels": 2200},
                {"count": 7, "lengthPixels": 700},
            ]
        )
        self.assertEqual(quality, "weak")
        self.assertGreater(evidence["countIqr"], 3)

    def test_diameter_calibration_round_trip(self):
        _, _, fabric_area = annulus_area_mm2((100, 90), (10, 8), 0.25)
        pitch = effective_pitch_from_known_length(fabric_area, 25)
        self.assertAlmostEqual(length_from_area(fabric_area, pitch), 25)


if __name__ == "__main__":
    unittest.main()
