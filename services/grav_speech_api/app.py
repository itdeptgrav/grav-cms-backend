"""Private HTTP API for central GRAV speech inference."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response

from .auth import AuthenticationError, verify
from .contracts import ContractError, parse_create_job
from .inference import InferenceError, ModelUnavailable, SpeechEngine
from .job_store import JobStore


ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = Path(os.environ.get("GRAV_SPEECH_STATE_DIR", ROOT / ".local-results/grav-speech-api"))
AUDIO_ROOT = Path(os.environ.get("GRAV_SPEECH_AUDIO_ROOT", STATE_DIR / "audio")).resolve()
MODEL_DIR = Path(os.environ.get("GRAV_SPEECH_MODEL_DIR", ROOT / ".local-models/indic-transcribe-flex"))
DIARIZER = Path(os.environ.get(
    "GRAV_SPEECH_DIARIZER_PATH",
    ROOT / ".local-models/diar-sortformer-4spk-v1/diar_sortformer_4spk-v1.nemo",
))
SECRET = os.environ.get("GRAV_SPEECH_SHARED_SECRET", "")
MAX_COMMAND_BYTES = int(os.environ.get("GRAV_SPEECH_MAX_COMMAND_BYTES", str(15 * 1024 * 1024)))

store = JobStore(STATE_DIR / "jobs.sqlite3")
engine = SpeechEngine(MODEL_DIR, DIARIZER)
stop_event = threading.Event()
worker_thread: threading.Thread | None = None

app = FastAPI(title="GRAV Speech", version="1.0.0", docs_url=None, redoc_url=None)
logger = logging.getLogger("grav-speech")


def public_job(job: dict) -> dict:
    return {
        "schemaVersion": "1",
        "jobId": job["id"],
        "status": job["status"],
        "source": {
            "application": job["source_application"],
            "kind": job["source_kind"],
            "id": job["source_id"],
        },
        "features": {"diarization": job["diarization"]},
        "result": job["result"],
        "error": {"code": job["error_code"]} if job["error_code"] else None,
        "createdAt": job["created_at"],
        "updatedAt": job["updated_at"],
        "startedAt": job["started_at"],
        "completedAt": job["completed_at"],
    }


async def authenticate(request: Request, body: bytes):
    try:
        return verify(
            secret=SECRET,
            method=request.method,
            path=request.url.path,
            body=body,
            timestamp=request.headers.get("X-Grav-Timestamp"),
            service=request.headers.get("X-Grav-Service"),
            company_id=request.headers.get("X-Grav-Company-Id"),
            signature=request.headers.get("X-Grav-Signature"),
        )
    except AuthenticationError as error:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"}) from error


def resolve_audio_object(value: str) -> Path:
    candidate = (AUDIO_ROOT / value).resolve()
    if candidate == AUDIO_ROOT or AUDIO_ROOT not in candidate.parents:
        raise ValueError("Audio object escapes configured storage root")
    if not candidate.is_file():
        raise FileNotFoundError(value)
    return candidate


def worker_loop() -> None:
    try:
        engine.preload()
    except Exception:
        # Readiness remains false; jobs fail with a stable code rather than
        # crashing the HTTP process and losing the durable queue.
        logger.exception("ASR model preload failed")
    while not stop_event.is_set():
        job = store.claim_next()
        if job is None:
            stop_event.wait(0.25)
            continue
        try:
            source = resolve_audio_object(job["audio_object"])
            if store.is_cancel_requested(job["id"]):
                store.finish_cancellation(job["id"])
                continue
            result = engine.transcribe_recording(
                source,
                diarization=job["diarization"],
                stage=lambda value: store.mark_stage(job["id"], value),
            )
            if store.is_cancel_requested(job["id"]):
                # A running GPU operation cannot always be interrupted safely;
                # its result is discarded once cancellation was requested.
                store.finish_cancellation(job["id"])
                continue
            store.complete(job["id"], result)
        except FileNotFoundError:
            store.fail(job["id"], "SOURCE_FETCH_FAILED")
        except InferenceError as error:
            store.fail(job["id"], error.code)
        except Exception:
            store.fail(job["id"], "PROCESSING_FAILED")


@app.on_event("startup")
def startup() -> None:
    global worker_thread
    AUDIO_ROOT.mkdir(parents=True, exist_ok=True)
    if os.environ.get("GRAV_SPEECH_DISABLE_WORKER") == "1":
        return
    worker_thread = threading.Thread(target=worker_loop, name="grav-speech-worker", daemon=True)
    worker_thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    stop_event.set()
    if worker_thread:
        worker_thread.join(timeout=5)


@app.get("/health/live")
def live() -> dict:
    return {"status": "live", "service": "grav-speech", "schemaVersion": "1"}


@app.get("/health/ready")
def ready() -> dict:
    if worker_thread is not None and not worker_thread.is_alive():
        raise HTTPException(status_code=503, detail={"code": "WORKER_UNAVAILABLE"})
    if os.environ.get("GRAV_SPEECH_DISABLE_WORKER") != "1" and engine.asr is None:
        raise HTTPException(status_code=503, detail={"code": "MODEL_WARMING"})
    try:
        engine.verify_models()
    except ModelUnavailable as error:
        raise HTTPException(status_code=503, detail={"code": error.code}) from error
    return {"status": "ready", "service": "grav-speech", "schemaVersion": "1"}


@app.post("/v1/transcription-jobs")
async def create_job(request: Request, response: Response) -> dict:
    body = await request.body()
    identity = await authenticate(request, body)
    try:
        job_request = parse_create_job(json.loads(body))
    except (json.JSONDecodeError, ContractError) as error:
        raise HTTPException(status_code=400, detail={"code": "INVALID_REQUEST", "message": str(error)}) from error
    job, created = store.create(identity=identity, job=job_request)
    response.status_code = 202 if created else 200
    return public_job(job)


@app.get("/v1/transcription-jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> dict:
    identity = await authenticate(request, b"")
    job = store.get(job_id, identity)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "JOB_NOT_FOUND"})
    return public_job(job)


@app.post("/v1/transcription-jobs/{job_id}/cancel")
async def cancel_job(job_id: str, request: Request) -> dict:
    body = await request.body()
    identity = await authenticate(request, body)
    job = store.cancel(job_id, identity)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "JOB_NOT_FOUND"})
    return public_job(job)


@app.post("/v1/utterances:transcribe")
async def transcribe_utterance(request: Request) -> dict:
    body = await request.body()
    await authenticate(request, body)
    if not body or len(body) > MAX_COMMAND_BYTES:
        raise HTTPException(status_code=413, detail={"code": "AUDIO_SIZE_INVALID"})
    suffix = Path(request.headers.get("X-Audio-Filename", "audio.webm")).suffix[:10] or ".webm"
    temporary = tempfile.NamedTemporaryFile(prefix="grav-speech-", suffix=suffix, delete=False)
    try:
        temporary.write(body)
        temporary.close()
        return engine.transcribe_utterance(Path(temporary.name))
    except InferenceError as error:
        raise HTTPException(status_code=503, detail={"code": error.code}) from error
    finally:
        Path(temporary.name).unlink(missing_ok=True)
