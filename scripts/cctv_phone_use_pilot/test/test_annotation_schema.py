import json
import tempfile
import unittest
from pathlib import Path

from scripts.cctv_phone_use_pilot.annotation_schema import (
    AnnotationValidationError,
    read_jsonl,
    validate_dataset,
    validate_record,
)
from scripts.cctv_phone_use_pilot.build_review_queue import build_review_records, load_observations
from scripts.cctv_phone_use_pilot.apply_reviews import apply_decisions, read_decisions
from scripts.cctv_phone_use_pilot.adjudication import build_blinded_queue, compare_reviews


def pending_record(**overrides):
    record = {
        "schemaVersion": "phone-use-review-v1",
        "annotationId": "clip-a-t5-00001000-001",
        "split": "DEVELOPMENT",
        "source": {
            "clipId": "clip-a",
            "sourceGroup": "camera-09-2026-08-28",
            "cameraRef": "camera-09",
            "capturedDate": "2026-08-28",
            "sha256": None,
        },
        "target": {"trackId": 5, "targetRef": "clip-a:track:5"},
        "window": {"startSeconds": 1.0, "endSeconds": 5.0},
        "reviewEvidence": {
            "phoneVisible": "UNCERTAIN",
            "ownedByTarget": "UNCERTAIN",
            "handDeviceContact": "UNCERTAIN",
            "gazeAtDevice": "UNCERTAIN",
            "phoneAtEar": "UNCERTAIN",
            "repetitiveManipulation": "UNCERTAIN",
        },
        "review": {
            "status": "PENDING",
            "label": None,
            "reviewerId": None,
            "reviewedAt": None,
            "confidence": None,
            "notes": "",
        },
        "modelSuggestion": {
            "pipelineVersion": "test-v1",
            "decision": "CANDIDATE",
        },
        "usedForTuning": False,
    }
    record.update(overrides)
    return record


class AnnotationSchemaTest(unittest.TestCase):
    def test_pending_record_is_valid(self):
        validate_record(pending_record())

    def test_labelled_record_requires_reviewer_evidence(self):
        record = pending_record()
        record["review"] = {
            "status": "LABELLED",
            "label": "PHONE_HELD",
            "reviewerId": None,
            "reviewedAt": None,
            "confidence": None,
            "notes": "phone is held but the person is speaking to a colleague",
        }
        with self.assertRaisesRegex(AnnotationValidationError, "reviewerId"):
            validate_record(record)

    def test_labelled_active_state_is_valid(self):
        record = pending_record()
        record["review"] = {
            "status": "LABELLED",
            "label": "ACTIVE_VIEW_OR_TYPE",
            "reviewerId": "reviewer-1",
            "reviewedAt": "2026-10-14T12:30:00+05:30",
            "confidence": "HIGH",
            "notes": "repeated tapping with gaze fixed on screen",
        }
        record["reviewEvidence"]["phoneVisible"] = "YES"
        record["reviewEvidence"]["ownedByTarget"] = "YES"
        validate_record(record)

    def test_source_group_cannot_cross_splits(self):
        first = pending_record()
        second = pending_record(annotationId="clip-b-t2-00001000-001", split="HOLDOUT")
        second["source"] = {**first["source"], "clipId": "clip-b"}
        with self.assertRaisesRegex(AnnotationValidationError, "split leakage"):
            validate_dataset([first, second])

    def test_holdout_cannot_be_marked_used_for_tuning(self):
        record = pending_record(split="HOLDOUT", usedForTuning=True)
        with self.assertRaisesRegex(AnnotationValidationError, "usedForTuning"):
            validate_record(record)

    def test_jsonl_reports_line_number(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.jsonl"
            path.write_text(json.dumps(pending_record()) + "\n{broken\n", encoding="utf-8")
            with self.assertRaisesRegex(AnnotationValidationError, "line 2"):
                read_jsonl(path)


class ReviewQueueTest(unittest.TestCase):
    def test_model_states_become_pending_reviews_not_ground_truth(self):
        observations = [
            {"_timeSeconds": 1.0, "track": 5, "state": "ACTIVE", "object": True},
            {"_timeSeconds": 2.0, "track": 5, "state": "ACTIVE", "object": True},
            {"_timeSeconds": 3.0, "track": 5, "state": "NOT_ACTIVE", "object": False},
        ]
        records = build_review_records(
            observations,
            clip_id="clip-a",
            source_group="camera-09-day-1",
            camera_ref="camera-09",
            captured_date="2026-08-28",
            source_sha256=None,
            split="DEVELOPMENT",
            sample_seconds=1.0,
            max_gap_seconds=2.0,
            window_seconds=4.0,
            candidate_only=False,
        )
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["modelSuggestion"]["decision"], "ACTIVE")
        self.assertEqual(records[0]["review"]["status"], "PENDING")
        self.assertIsNone(records[0]["review"]["label"])
        validate_dataset(records)

    def test_candidate_only_excludes_not_active_segments(self):
        records = build_review_records(
            [
                {"_timeSeconds": 1.0, "track_id": 3, "emitted_label": "no_observable_task"},
                {"_timeSeconds": 2.0, "track_id": 3, "emitted_label": "using_phone"},
            ],
            clip_id="clip-a",
            source_group="camera-09-day-1",
            camera_ref="camera-09",
            captured_date="2026-08-28",
            source_sha256=None,
            split="DEVELOPMENT",
            sample_seconds=1.0,
            max_gap_seconds=2.0,
            window_seconds=4.0,
            candidate_only=True,
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["modelSuggestion"]["decision"], "ACTIVE")

    def test_loads_existing_timeline_report_shape(self):
        document = {
            "timeline": [{
                "time_seconds": 4.0,
                "observations": [{"track_id": 8, "emitted_label": "using_phone"}],
            }]
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            observations = load_observations(path)
        self.assertEqual(observations[0]["_timeSeconds"], 4.0)
        self.assertEqual(observations[0]["track_id"], 8)

    def test_loads_worker_log_and_ignores_model_startup_noise(self):
        contents = """Downloading checkpoint\nwarning: model startup\n{"time": 4.0, "track": 3, "state": "NO PHONE"}\n"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "worker.log"
            path.write_text(contents, encoding="utf-8")
            observations = load_observations(path)
        self.assertEqual(len(observations), 1)
        records = build_review_records(
            observations,
            clip_id="clip-a",
            source_group="camera-09-day-1",
            camera_ref="camera-09",
            captured_date="2026-08-28",
            source_sha256=None,
            split="DEVELOPMENT",
            sample_seconds=1.0,
            max_gap_seconds=2.0,
            window_seconds=4.0,
            candidate_only=False,
        )
        self.assertEqual(records[0]["modelSuggestion"]["decision"], "NOT_ACTIVE")

    def test_long_detector_state_is_split_into_fixed_review_windows(self):
        records = build_review_records(
            [
                {"_timeSeconds": float(second), "track": 3, "state": "ACTIVE"}
                for second in range(10)
            ],
            clip_id="clip-a",
            source_group="camera-09-day-1",
            camera_ref="camera-09",
            captured_date="2026-08-28",
            source_sha256=None,
            split="DEVELOPMENT",
            sample_seconds=1.0,
            max_gap_seconds=2.0,
            window_seconds=4.0,
            candidate_only=True,
        )
        self.assertEqual(len(records), 3)
        self.assertEqual(records[0]["window"], {"startSeconds": 0.0, "endSeconds": 4.0})
        self.assertEqual(records[1]["window"], {"startSeconds": 4.0, "endSeconds": 8.0})
        self.assertEqual(records[2]["window"], {"startSeconds": 8.0, "endSeconds": 10.0})


class ApplyReviewsTest(unittest.TestCase):
    def decision_document(self, decisions):
        return {
            "schemaVersion": "phone-use-review-decisions-v1",
            "reviewerId": "reviewer-1",
            "reviewedAt": "2026-10-14T18:45:00+05:30",
            "decisions": decisions,
        }

    def test_applies_review_without_promoting_model_suggestion(self):
        record = pending_record()
        decisions = {
            record["annotationId"]: {
                "annotationId": record["annotationId"],
                "label": "PHONE_HELD",
                "confidence": "HIGH",
                "notes": "Phone held; gaze remains elsewhere.",
                "reviewEvidence": {"phoneVisible": "YES", "gazeAtDevice": "NO"},
                "reviewerId": "reviewer-1",
                "reviewedAt": "2026-10-14T18:45:00+05:30",
            }
        }
        output = apply_decisions([record], decisions, require_complete=True)
        self.assertEqual(output[0]["review"]["label"], "PHONE_HELD")
        self.assertEqual(output[0]["modelSuggestion"]["decision"], "CANDIDATE")
        self.assertEqual(output[0]["reviewEvidence"]["phoneVisible"], "YES")

    def test_unknown_decision_fails_closed(self):
        decision = {
            "missing": {
                "annotationId": "missing",
                "label": "NO_PHONE",
                "confidence": "HIGH",
                "notes": "",
                "reviewEvidence": {},
                "reviewerId": "reviewer-1",
                "reviewedAt": "2026-10-14T18:45:00+05:30",
            }
        }
        with self.assertRaisesRegex(AnnotationValidationError, "unknown annotationId"):
            apply_decisions([pending_record()], decision)

    def test_require_complete_rejects_pending_records(self):
        with self.assertRaisesRegex(AnnotationValidationError, "remain pending"):
            apply_decisions([pending_record()], {}, require_complete=True)

    def test_decision_file_rejects_duplicate_ids(self):
        item = {
            "annotationId": "clip-a-t5-00001000-001",
            "label": "NO_PHONE",
            "confidence": "HIGH",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "decisions.json"
            path.write_text(
                json.dumps(self.decision_document([item, item])), encoding="utf-8"
            )
            with self.assertRaisesRegex(AnnotationValidationError, "duplicate decision"):
                read_decisions(path)


class AdjudicationTest(unittest.TestCase):
    def labelled_record(self, reviewer="reviewer-1", label="PHONE_HELD"):
        record = pending_record()
        record["review"] = {
            "status": "LABELLED",
            "label": label,
            "reviewerId": reviewer,
            "reviewedAt": "2026-10-14T18:45:00+05:30",
            "confidence": "HIGH",
            "notes": "reviewed",
        }
        record["reviewEvidence"]["phoneVisible"] = "YES"
        return record

    def test_blinded_queue_removes_labels_suggestions_and_evidence(self):
        record = self.labelled_record()
        blinded = build_blinded_queue([record])
        self.assertEqual(blinded[0]["review"]["status"], "PENDING")
        self.assertIsNone(blinded[0]["review"]["label"])
        self.assertIsNone(blinded[0]["modelSuggestion"])
        self.assertTrue(all(value == "UNCERTAIN" for value in blinded[0]["reviewEvidence"].values()))
        self.assertTrue(blinded[0]["reviewRound"]["blinded"])

    def test_blinding_rejects_incomplete_source_review(self):
        with self.assertRaisesRegex(AnnotationValidationError, "must be complete"):
            build_blinded_queue([pending_record()])

    def test_comparison_requires_independent_reviewers(self):
        record = self.labelled_record()
        with self.assertRaisesRegex(AnnotationValidationError, "different reviewerId"):
            compare_reviews([record], [record])

    def test_comparison_reports_semantic_and_active_disagreement(self):
        first = self.labelled_record(reviewer="reviewer-1", label="PHONE_HELD")
        second = self.labelled_record(reviewer="reviewer-2", label="ACTIVE_VIEW_OR_TYPE")
        report = compare_reviews([first], [second])
        self.assertEqual(report["exactAgreementRate"], 0.0)
        self.assertEqual(report["activeBinaryAgreementRate"], 0.0)
        self.assertTrue(report["requiresAdjudication"])
        self.assertTrue(report["disagreements"][0]["activeUseDisagreement"])


if __name__ == "__main__":
    unittest.main()

