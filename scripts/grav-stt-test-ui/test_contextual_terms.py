import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from contextual_terms import apply_normalizations, validate_proposal, wider_context_packet


CATALOG = {
    "version": "garment-v1",
    "terms": [{
        "id": "material.polyester", "canonicalText": "polyester", "type": "material",
        "aliases": ["polyster", "poly star", "police star", "poly ester"],
    }],
}


class ContextualTermsTest(unittest.TestCase):
    def test_glossary_term_can_replace_literal_mishearing_in_derived_view(self):
        result = {"utteranceReviews": [{
            "id": "u-1", "selectedRomanText": "Police star suno na tum yeh apna man se mat banao",
        }]}
        applied = apply_normalizations(result, [{
            "id": "u-1", "rawPhrase": "Police star", "canonicalTermId": "material.polyester",
            "confidence": 0.96, "reason": "garment/fabric discussion in surrounding transcript",
        }], CATALOG)
        self.assertEqual(applied, 1)
        window = result["utteranceReviews"][0]
        self.assertEqual(window["selectedRomanText"], "Police star suno na tum yeh apna man se mat banao")
        self.assertIn("polyester", window["contextualNormalizedRomanText"])
        self.assertEqual(window["contextualNormalizations"][0]["canonicalTermId"], "material.polyester")

    def test_prose_or_unknown_terms_cannot_be_invented(self):
        window = {"selectedRomanText": "Main woh discuss kyon nahi kiya hai Police star suno"}
        self.assertIsNone(validate_proposal(window, {
            "rawPhrase": "Main woh discuss", "canonicalTermId": "material.polyester", "confidence": 0.99,
        }, CATALOG))
        self.assertIsNone(validate_proposal(window, {
            "rawPhrase": "Police star", "canonicalTermId": "material.unknown", "confidence": 0.99,
        }, CATALOG))

    def test_context_is_broader_than_one_neighbour(self):
        windows = [
            {"id": f"u-{n}", "speaker": "Speaker 1", "startSeconds": n * 30,
             "endSeconds": n * 30 + 28, "rawRomanText": f"turn {n}"}
            for n in range(9)
        ]
        packet = wider_context_packet(windows, 4, CATALOG, radius=4, meeting_context="garment order meeting")
        self.assertEqual(len(packet["surroundingTranscript"]), 9)
        self.assertEqual(packet["meetingContext"], "garment order meeting")
        self.assertEqual(packet["termCatalog"][0]["id"], "material.polyester")


if __name__ == "__main__":
    unittest.main()
