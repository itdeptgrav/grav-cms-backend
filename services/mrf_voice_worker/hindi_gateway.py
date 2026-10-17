"""Pod-private Hindi TTS gateway backed by Chatterbox V3 Hindi."""

from __future__ import annotations

import io
import os
import sys
import threading
from pathlib import Path

import httpx
import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from huggingface_hub import snapshot_download
from pydantic import BaseModel


KEY = os.environ.get("GRAV_SPEECH_GATEWAY_KEY", "local-only")
DEVICE = os.environ.get("GRAV_TTS_DEVICE", "cuda")
SOURCE_REPO = os.environ.get(
    "GRAV_HINDI_CHATTERBOX_SOURCE",
    "ResembleAI/Chatterbox-Multilingual-TTS-hi",
)
REFERENCE_URL = os.environ.get(
    "GRAV_HINDI_CHATTERBOX_REFERENCE_URL",
    "https://storage.googleapis.com/chatterbox-demo-samples/mtl_prompts/hi_f1.flac",
)
REFERENCE_PATH = Path(os.environ.get(
    "GRAV_HINDI_CHATTERBOX_REFERENCE_PATH",
    "/workspace/grav-mrf-voice/cache/chatterbox/hi_f1.flac",
))

app = FastAPI(title="GRAV Hindi Speech Gateway", docs_url=None, redoc_url=None)
model_lock = threading.Lock()
model = None


def authenticate(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {KEY}":
        raise HTTPException(status_code=401, detail="Unauthenticated")


def reference_audio() -> Path:
    if REFERENCE_PATH.is_file() and REFERENCE_PATH.stat().st_size:
        return REFERENCE_PATH
    REFERENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = REFERENCE_PATH.with_suffix(".tmp")
    with httpx.stream("GET", REFERENCE_URL, timeout=60, follow_redirects=True) as response:
        response.raise_for_status()
        with temporary.open("wb") as destination:
            for chunk in response.iter_bytes():
                destination.write(chunk)
    temporary.replace(REFERENCE_PATH)
    return REFERENCE_PATH


def speech_model():
    global model
    if model is not None:
        return model
    source_root = Path(snapshot_download(
        SOURCE_REPO,
        repo_type="space",
        allow_patterns=["chatterbox/**"],
    ))
    source_path = str(source_root / "chatterbox" / "src")
    if source_path not in sys.path:
        sys.path.insert(0, source_path)
    from chatterbox.tts import ChatterboxTTS

    loaded = ChatterboxTTS.from_pretrained(DEVICE)
    loaded.prepare_conditionals(str(reference_audio()), exaggeration=0.45)
    model = loaded
    return model


@app.on_event("startup")
def prewarm() -> None:
    with model_lock:
        speech_model()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ready" if model is not None else "loading",
        "loaded": model is not None,
        "model": "ResembleAI/Chatterbox-Multilingual-hi",
        "language": "hi",
        "device": DEVICE,
    }


class SpeechRequest(BaseModel):
    model: str = "chatterbox-hi"
    input: str
    voice: str = "hi_female"
    response_format: str = "wav"
    speed: float = 1.0


@app.post("/v1/audio/speech", dependencies=[Depends(authenticate)])
def speech(body: SpeechRequest) -> Response:
    if body.model != "chatterbox-hi":
        raise HTTPException(status_code=400, detail="Unsupported Hindi speech model")
    if body.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only wav output is supported")
    text = body.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Speech text is required")
    with model_lock:
        audio = speech_model().generate(
            text,
            language_id="hi",
            exaggeration=0.45,
            cfg_weight=0.4,
            temperature=0.75,
        )
    values = audio.squeeze(0).cpu().numpy()
    stream = io.BytesIO()
    sf.write(stream, values, speech_model().sr, format="WAV", subtype="PCM_16")
    return Response(stream.getvalue(), media_type="audio/wav")
