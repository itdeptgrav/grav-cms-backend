import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from transcript_quality import (
    add_speaker_evidence, build_utterance_windows, deterministic_flags, numeric_evidence,
)
from transcript_reasoner import reasoner_packets


class TranscriptQualityTest(unittest.TestCase):
    def test_repetition_loop_is_flagged(self):
        text = " ".join(["woh woh woh woh"] * 8)
        self.assertIn("decoder_repetition_loop", deterministic_flags(text, 8.0))

    def test_short_backchannel_is_uncertain_not_rewritten(self):
        turns = [{
            "index": 0, "speaker": "Speaker 4", "startSeconds": 1.0,
            "endSeconds": 1.6, "durationSeconds": 0.6,
            "rawRomanText": "Sahi", "qualityFlags": deterministic_flags("Sahi", 0.6),
        }]
        evidence = add_speaker_evidence(turns)
        self.assertFalse(evidence["Speaker 4"]["reliableChannel"])
        self.assertEqual(turns[0]["rawRomanText"], "Sahi")
        self.assertEqual(turns[0]["qualityState"], "uncertain")

    def test_fragmented_nonsense_is_reviewed_as_one_window_without_losing_turns(self):
        turns = [
            {"index": 0, "speaker": "Speaker 2", "startSeconds": 44.08, "endSeconds": 46.0,
             "durationSeconds": 1.92, "rawRomanText": "Mera naam Venkatagiriya", "qualityFlags": []},
            {"index": 1, "speaker": "Speaker 2", "startSeconds": 47.76, "endSeconds": 48.4,
             "durationSeconds": 0.64, "rawRomanText": "O", "qualityFlags": ["audio_span_too_short"]},
            {"index": 2, "speaker": "Speaker 2", "startSeconds": 49.92, "endSeconds": 51.44,
             "durationSeconds": 1.52, "rawRomanText": "Daang Rapping", "qualityFlags": []},
        ]
        windows = build_utterance_windows(turns)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["turnIndexes"], [0, 1, 2])
        self.assertEqual(windows[0]["rawRomanText"], "Mera naam Venkatagiriya O Daang Rapping")
        self.assertEqual([turn["rawRomanText"] for turn in turns], [
            "Mera naam Venkatagiriya", "O", "Daang Rapping"
        ])

    def test_reasoner_receives_context_but_no_rewrite_field(self):
        windows = [
            {"id": "u1", "speaker": "Speaker 1", "startSeconds": 0, "endSeconds": 1,
             "rawRomanText": "Okay", "qualityFlags": [], "candidateTranscripts": []},
            {"id": "u2", "speaker": "Speaker 2", "startSeconds": 1, "endSeconds": 3,
             "rawRomanText": "Daang Rapping", "qualityFlags": ["audio_span_too_short"],
             "candidateTranscripts": [{"id": "contextual_redecode", "romanText": "candidate"}]},
        ]
        packet = reasoner_packets(windows, domain_terms=["Highlander"])[0][1]
        self.assertEqual(packet["previousRawText"], "Okay")
        self.assertEqual(packet["candidateTranscripts"][0]["id"], "contextual_redecode")
        self.assertEqual(packet["domainTerms"], ["Highlander"])
        self.assertNotIn("replacementText", packet)
        self.assertEqual([item["id"] for item in packet["surroundingRawTranscript"]], ["u1", "u2"])

    def test_bare_decimal_is_not_silently_completed(self):
        evidence = numeric_evidence([
            {"id": "raw", "romanText": "point five metres"},
            {"id": "context", "romanText": "one point five metres"},
        ])
        self.assertIn("ambiguous_bare_decimal", evidence["flags"])
        self.assertIn("numeric_candidate_conflict", evidence["flags"])
        self.assertFalse(evidence["safeForStructuredFacts"])


if __name__ == "__main__":
    unittest.main()
