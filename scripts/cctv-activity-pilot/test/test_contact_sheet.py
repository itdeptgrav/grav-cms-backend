import unittest

from PIL import Image

from scripts.cctv_activity_pilot.qwen_temporal_prompt import build_contact_sheet


class ContactSheetTest(unittest.TestCase):
    def test_four_frames_fit_one_fixed_size_image(self):
        frames = [Image.new("RGB", (320 + index, 480), color=(index * 20, 40, 80)) for index in range(4)]
        sheet = build_contact_sheet(frames)
        self.assertEqual(sheet.size, (448, 448))

    def test_more_than_four_frames_fails_closed(self):
        frames = [Image.new("RGB", (32, 32)) for _ in range(5)]
        with self.assertRaises(ValueError):
            build_contact_sheet(frames)


if __name__ == "__main__":
    unittest.main()
