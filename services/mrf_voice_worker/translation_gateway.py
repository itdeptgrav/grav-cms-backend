"""Pod-private, dedicated English-to-Indic translation adapter.

Dialogue and translation are deliberately separate. Qwen may interpret an
ambiguous approval utterance, but it must not rewrite text for the speech
model. IndicTrans2 produces the selected-language text consumed by Qwen/TTS.
"""

from __future__ import annotations

import os
import re
import threading

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from indictrans_onnx import IndicTransOnnx


KEY = os.environ.get("GRAV_TRANSLATION_GATEWAY_KEY", os.environ.get("GRAV_SPEECH_GATEWAY_KEY", "local-only"))
MODEL_ID = os.environ.get(
    "GRAV_TRANSLATION_MODEL",
    "naklitechie/indictrans2-en-indic-dist-200M-ONNX",
)
DEVICE = "cpu"
TARGETS = {"hi": "hin_Deva", "or": "ory_Orya"}

app = FastAPI(title="GRAV Indic Translation Gateway", docs_url=None, redoc_url=None)
lock = threading.Lock()
model = None


def authenticate(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {KEY}":
        raise HTTPException(status_code=401, detail="Unauthenticated")


def load_model() -> IndicTransOnnx:
    global model
    if model is None:
        model = IndicTransOnnx(MODEL_ID)
    return model


@app.on_event("startup")
def prewarm_model() -> None:
    with lock:
        load_model()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ready" if model is not None else "warming",
        "model": MODEL_ID,
        "device": DEVICE,
        "loaded": model is not None,
    }


class TranslationRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    language: str = Field(pattern="^(hi|or)$")


@app.post("/v1/translate", dependencies=[Depends(authenticate)])
def translate(body: TranslationRequest) -> dict:
    target = TARGETS[body.language]
    source = body.text.strip()
    expected = re.compile(r"[\u0900-\u097f]" if body.language == "hi" else r"[\u0b00-\u0b7f]")
    # Already-native sentences should not take a model round trip. Mixed-script
    # CMS facts still go through translation so TTS never receives Latin text.
    if expected.search(source) and not re.search(r"[A-Za-z]", source):
        return {"text": source, "language": body.language, "model": "native-pass-through"}

    with lock:
        translated = load_model().translate(source, target).strip()
    if not translated or not expected.search(translated):
        raise HTTPException(status_code=503, detail="Translation model did not return selected-language text")
    return {"text": translated[:2000], "language": body.language, "model": MODEL_ID}
