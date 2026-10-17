from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from services.grav_speech_api.auth import AuthenticationError, sign, verify
from services.grav_speech_api.contracts import ContractError, parse_create_job
from services.grav_speech_api.job_store import JobStore
from services.grav_speech_api.transcript_quality import deoverlap_presentation, windows


class SpeechFoundationTest(unittest.TestCase):
    def test_signature_binds_company_service_path_and_body(self):
        body = b'{"hello":"world"}'
        signature = sign("secret", "POST", "/v1/jobs", "1000", "voice", "company-a", body)
        identity = verify(
            secret="secret", method="POST", path="/v1/jobs", timestamp="1000",
            service="voice", company_id="company-a", signature=signature,
            body=body, now=1000,
        )
        self.assertEqual(identity.company_id, "company-a")
        with self.assertRaises(AuthenticationError):
            verify(
                secret="secret", method="POST", path="/v1/jobs", timestamp="1000",
                service="voice", company_id="company-b", signature=signature,
                body=body, now=1000,
            )

    def test_contract_refuses_model_selection_and_arbitrary_url(self):
        payload = {
            "source": {"application": "voice", "kind": "call_event", "id": "call-1",
                       "audioObject": "calls/call-1.wav"},
            "features": {"diarization": True},
            "idempotencyKey": "call-1:audio-v1",
        }
        parsed = parse_create_job(payload)
        self.assertTrue(parsed.diarization)
        with self.assertRaises(ContractError):
            parse_create_job({**payload, "model": "caller-selected"})
        with self.assertRaises(ContractError):
            parse_create_job({**payload, "source": {**payload["source"], "audioObject": "https://evil.test/a.wav"}})
        with self.assertRaises(ContractError):
            parse_create_job({**payload, "features": {"diarization": True, "expectedSpeakerCount": 3}})

    def test_job_is_company_scoped_and_idempotent(self):
        request = parse_create_job({
            "source": {"application": "voice", "kind": "call_event", "id": "call-1",
                       "audioObject": "calls/call-1.wav"},
            "features": {"diarization": True},
            "idempotencyKey": "call-1:audio-v1",
        })
        identity = type("Identity", (), {"company_id": "company-a", "service": "voice"})()
        other = type("Identity", (), {"company_id": "company-b", "service": "voice"})()
        with tempfile.TemporaryDirectory() as directory:
            store = JobStore(Path(directory) / "jobs.sqlite3")
            first, created = store.create(identity=identity, job=request)
            again, repeated = store.create(identity=identity, job=request)
            self.assertTrue(created)
            self.assertFalse(repeated)
            self.assertEqual(first["id"], again["id"])
            self.assertIsNone(store.get(first["id"], other))

    def test_job_store_defaults_to_rollback_journal_for_fuse_compatibility(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.sqlite3"
            JobStore(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")

    def test_context_windows_preserve_raw_evidence_for_semantic_recovery(self):
        grouped = windows([
            {"index": 1, "speaker": "Speaker 2", "startSeconds": 51.8, "endSeconds": 61.4,
             "rawRomanText": "Hailand label", "qualityFlags": []},
            {"index": 2, "speaker": "Speaker 2", "startSeconds": 61.9, "endSeconds": 68.6,
             "rawRomanText": "offline stores hain", "qualityFlags": []},
        ])
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["turnIndexes"], [1, 2])
        self.assertIn("Hailand label offline stores hain", grouped[0]["rawRomanText"])

    def test_presentation_removes_only_exact_context_overlap(self):
        reviews = [
            {"selectedRomanText": "offline stores hain then we have around five stores in Dubai"},
            {"selectedRomanText": "Then we have around five stores in Dubai Then we have online sales"},
            {"selectedRomanText": "We have five categories hai hamare paas"},
            {"selectedRomanText": "We have five categories hai hamare paas five category hai ek to shirt hai"},
        ]
        deoverlap_presentation(reviews)
        self.assertEqual(reviews[1]["presentationRomanText"], "Then we have online sales")
        self.assertEqual(reviews[3]["presentationRomanText"], "five category hai ek to shirt hai")
        self.assertEqual(reviews[1]["selectedRomanText"], "Then we have around five stores in Dubai Then we have online sales")


if __name__ == "__main__":
    unittest.main()
