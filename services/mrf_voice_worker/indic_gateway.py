"""Pod-private streaming Indic Parler-TTS adapter for Hindi and Odia."""

from __future__ import annotations

import base64
import json
import os
import threading
from pathlib import Path

import numpy as np
import torch
import torchaudio
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from parler_tts import ParlerTTSForConditionalGeneration, ParlerTTSStreamer
from pydantic import BaseModel
from transformers import AutoTokenizer


KEY = os.environ.get("GRAV_SPEECH_GATEWAY_KEY", "local-only")
DEVICE = os.environ.get("GRAV_TTS_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
MODEL_PATH = Path(os.environ.get("GRAV_PARLER_MODEL_PATH", "/workspace/models/indic-parler-tts"))
OUTPUT_SAMPLE_RATE = 24000
PLAY_STEPS = max(10, int(os.environ.get("GRAV_PARLER_PLAY_STEPS", "10")))

app = FastAPI(title="GRAV Indic Parler Gateway", docs_url=None, redoc_url=None)
model = None
prompt_tokenizer = None
description_tokenizer = None
generation_lock = threading.Lock()

VOICE_DESCRIPTIONS = {
    "hi": (
        "Divya speaks in natural everyday Hindi, like a helpful Indian colleague on a phone "
        "call. Her pace is relaxed but not slow, with fluid connected phrasing, subtle pitch "
        "variation, and brief pauses only at sentence boundaries. She does not pause between "
        "ordinary words or sound like she is reading. The recording is close, clear, and free "
        "of background noise."
    ),
    "or": (
        "Debjani speaks in natural everyday Odia, like a helpful Odia colleague on a phone "
        "call. Her pace is relaxed but not slow, with fluid connected phrasing, subtle pitch "
        "variation, and brief pauses only at sentence boundaries. She does not pause between "
        "ordinary words or sound like she is reading. The recording is close, clear, and free "
        "of background noise."
    ),
}


def authenticate(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {KEY}":
        raise HTTPException(status_code=401, detail="Unauthenticated")


@app.on_event("startup")
def prewarm_model() -> None:
    global model, prompt_tokenizer, description_tokenizer
    if not MODEL_PATH.is_dir():
        raise RuntimeError(f"Indic Parler model is missing: {MODEL_PATH}")
    model = ParlerTTSForConditionalGeneration.from_pretrained(
        str(MODEL_PATH),
        torch_dtype=torch.float16,
        local_files_only=True,
    ).to(DEVICE)
    # A40 Tensor Cores can use TF32 for the remaining float32 matrix work.
    # This changes neither speaking rate nor the generated waveform timing; it
    # only reduces synthesis time so streamed playout is less likely to starve.
    torch.backends.cuda.matmul.allow_tf32 = True
    prompt_tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH), local_files_only=True)
    description_tokenizer = AutoTokenizer.from_pretrained(
        model.config.text_encoder._name_or_path,
        local_files_only=True,
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ready" if model is not None else "warming",
        "model": "ai4bharat/indic-parler-tts",
        "device": DEVICE,
        "loaded": model is not None,
        "languages": ["hi", "or"],
        "voices": {"hi": "Divya", "or": "Debjani"},
        "streaming": True,
    }


class SpeechRequest(BaseModel):
    model: str
    input: str
    voice: str = "default"
    response_format: str = "wav"
    speed: float = 1.0


def sse_event(event: dict) -> bytes:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n".encode("utf-8")


def generate_audio(text: str, language: str):
    error: list[BaseException] = []
    with generation_lock:
        description = description_tokenizer(
            VOICE_DESCRIPTIONS[language], return_tensors="pt"
        ).to(DEVICE)
        prompt = prompt_tokenizer(text, return_tensors="pt").to(DEVICE)
        streamer = ParlerTTSStreamer(model, device=DEVICE, play_steps=PLAY_STEPS)

        def run_generation() -> None:
            try:
                with torch.inference_mode():
                    model.generate(
                        input_ids=description.input_ids,
                        attention_mask=description.attention_mask,
                        prompt_input_ids=prompt.input_ids,
                        prompt_attention_mask=prompt.attention_mask,
                        streamer=streamer,
                    )
            except BaseException as exc:  # ensure the response iterator cannot hang
                error.append(exc)
                streamer.end()

        thread = threading.Thread(target=run_generation, daemon=True)
        thread.start()
        for audio in streamer:
            if not len(audio):
                continue
            waveform = torch.from_numpy(np.asarray(audio, dtype=np.float32))
            waveform = torchaudio.functional.resample(
                waveform, model.config.sampling_rate, OUTPUT_SAMPLE_RATE
            )
            pcm = (
                waveform.clamp(-1.0, 1.0).mul(32767).round().to(torch.int16).numpy().tobytes()
            )
            yield sse_event(
                {
                    "type": "speech.audio.delta",
                    "delta": base64.b64encode(pcm).decode("ascii"),
                }
            )
        thread.join()
        if error:
            raise RuntimeError("Indic Parler generation failed") from error[0]
        yield sse_event({"type": "speech.audio.done"})
        yield b"data: [DONE]\n\n"


@app.post("/v1/audio/speech", dependencies=[Depends(authenticate)])
def speech(body: SpeechRequest) -> StreamingResponse:
    aliases = {
        "parler-hi": "hi",
        "parler-or": "or",
        # Keep old clients working during the rolling deployment.
        "indicf5-hi": "hi",
        "indicf5-or": "or",
    }
    language = aliases.get(body.model)
    if language is None:
        raise HTTPException(status_code=400, detail="Unsupported Indic speech model")
    text = body.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Speech text is required")
    if model is None:
        raise HTTPException(status_code=503, detail="Indic Parler is still warming")
    return StreamingResponse(generate_audio(text, language), media_type="text/event-stream")
