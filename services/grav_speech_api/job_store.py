"""SQLite-backed durable queue for the first central service deployment."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TERMINAL = {"succeeded", "failed", "cancelled"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self._initialise()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialise(self) -> None:
        with self._connect() as db:
            # RunPod's durable /workspace volume is mounted through FUSE/geesefs.
            # SQLite WAL relies on shared-memory and locking behaviour that this
            # mount does not provide reliably, causing a healthy model worker to
            # die with SQLITE_IOERR. A rollback journal is slower but safe for
            # this single-process, low-volume queue. WAL remains an explicit
            # opt-in for deployments backed by a normal local filesystem.
            journal_mode = os.environ.get("GRAV_SPEECH_SQLITE_JOURNAL_MODE", "DELETE").upper()
            if journal_mode not in {"DELETE", "WAL"}:
                raise ValueError("GRAV_SPEECH_SQLITE_JOURNAL_MODE must be DELETE or WAL")
            db.execute(f"PRAGMA journal_mode={journal_mode}")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS transcription_jobs (
                  id TEXT PRIMARY KEY,
                  company_id TEXT NOT NULL,
                  requesting_service TEXT NOT NULL,
                  source_application TEXT NOT NULL,
                  source_kind TEXT NOT NULL,
                  source_id TEXT NOT NULL,
                  audio_object TEXT NOT NULL,
                  diarization INTEGER NOT NULL,
                  idempotency_key TEXT NOT NULL,
                  status TEXT NOT NULL,
                  cancel_requested INTEGER NOT NULL DEFAULT 0,
                  result_json TEXT,
                  error_code TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  started_at TEXT,
                  completed_at TEXT,
                  UNIQUE(company_id, requesting_service, idempotency_key)
                );
                CREATE INDEX IF NOT EXISTS speech_jobs_queue
                  ON transcription_jobs(status, created_at);
                """
            )
            recovered = now_iso()
            db.execute(
                """UPDATE transcription_jobs SET status='queued', updated_at=?, started_at=NULL
                   WHERE status IN ('fetching','diarizing','transcribing') AND cancel_requested=0""",
                (recovered,),
            )
            db.execute(
                """UPDATE transcription_jobs SET status='cancelled', updated_at=?, completed_at=?
                   WHERE status IN ('fetching','diarizing','transcribing') AND cancel_requested=1""",
                (recovered, recovered),
            )

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        value = dict(row)
        value["diarization"] = bool(value["diarization"])
        value["cancel_requested"] = bool(value["cancel_requested"])
        value["result"] = json.loads(value.pop("result_json")) if value.get("result_json") else None
        return value

    def create(self, *, identity, job) -> tuple[dict[str, Any], bool]:
        created = now_iso()
        job_id = f"stt_{uuid.uuid4().hex}"
        with self._lock, self._connect() as db:
            try:
                db.execute(
                    """INSERT INTO transcription_jobs (
                      id, company_id, requesting_service, source_application,
                      source_kind, source_id, audio_object, diarization,
                      idempotency_key, status,
                      created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)""",
                    (
                        job_id, identity.company_id, identity.service,
                        job.source.application, job.source.kind, job.source.source_id,
                        job.source.audio_object, int(job.diarization),
                        job.idempotency_key, created, created,
                    ),
                )
                was_created = True
            except sqlite3.IntegrityError:
                was_created = False
            row = db.execute(
                """SELECT * FROM transcription_jobs
                   WHERE company_id=? AND requesting_service=? AND idempotency_key=?""",
                (identity.company_id, identity.service, job.idempotency_key),
            ).fetchone()
        return self._row(row), was_created

    def get(self, job_id: str, identity) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM transcription_jobs WHERE id=? AND company_id=? AND requesting_service=?",
                (job_id, identity.company_id, identity.service),
            ).fetchone()
        return self._row(row)

    def claim_next(self) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM transcription_jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            changed = now_iso()
            db.execute(
                "UPDATE transcription_jobs SET status='fetching', started_at=?, updated_at=? WHERE id=? AND status='queued'",
                (changed, changed, row["id"]),
            )
            db.execute("COMMIT")
            return self._row(db.execute("SELECT * FROM transcription_jobs WHERE id=?", (row["id"],)).fetchone())

    def mark_stage(self, job_id: str, status: str) -> None:
        if status not in {"diarizing", "transcribing"}:
            raise ValueError("invalid processing stage")
        with self._connect() as db:
            db.execute(
                "UPDATE transcription_jobs SET status=?, updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')",
                (status, now_iso(), job_id),
            )

    def complete(self, job_id: str, result: dict[str, Any]) -> None:
        finished = now_iso()
        with self._connect() as db:
            db.execute(
                """UPDATE transcription_jobs SET status='succeeded', result_json=?,
                   updated_at=?, completed_at=? WHERE id=? AND status NOT IN ('failed','cancelled')""",
                (json.dumps(result, ensure_ascii=False), finished, finished, job_id),
            )

    def fail(self, job_id: str, code: str) -> None:
        finished = now_iso()
        with self._connect() as db:
            db.execute(
                """UPDATE transcription_jobs SET status='failed', error_code=?,
                   updated_at=?, completed_at=? WHERE id=? AND status != 'cancelled'""",
                (code, finished, finished, job_id),
            )

    def cancel(self, job_id: str, identity) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT * FROM transcription_jobs WHERE id=? AND company_id=? AND requesting_service=?",
                (job_id, identity.company_id, identity.service),
            ).fetchone()
            if row is None:
                return None
            if row["status"] == "queued":
                finished = now_iso()
                db.execute(
                    "UPDATE transcription_jobs SET status='cancelled', cancel_requested=1, updated_at=?, completed_at=? WHERE id=?",
                    (finished, finished, job_id),
                )
            elif row["status"] not in TERMINAL:
                db.execute(
                    "UPDATE transcription_jobs SET cancel_requested=1, updated_at=? WHERE id=?",
                    (now_iso(), job_id),
                )
            return self._row(db.execute("SELECT * FROM transcription_jobs WHERE id=?", (job_id,)).fetchone())

    def finish_cancellation(self, job_id: str) -> None:
        finished = now_iso()
        with self._connect() as db:
            db.execute(
                """UPDATE transcription_jobs SET status='cancelled', cancel_requested=1,
                   updated_at=?, completed_at=? WHERE id=? AND status NOT IN ('succeeded','failed')""",
                (finished, finished, job_id),
            )

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT cancel_requested FROM transcription_jobs WHERE id=?", (job_id,)).fetchone()
        return bool(row and row[0])
