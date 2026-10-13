#!/usr/bin/env python3
"""Single-model, raw transcription runner for the temporary GRAV Voice tester.

The model itself chooses its transcription prompt and renders Romanized text.
There is no language router, per-language ASR lane, external Romanizer, LLM,
or transcript correction in this runner.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import soundfile as sf

MODEL_DIR = Path("/root/indic-transcribe-flex")
MODEL = None


def preload_model():
    global MODEL
    if MODEL is None:
        sys.path.insert(0, str(MODEL_DIR))
        from indic_transcribe import IndicTranscribe

        MODEL = IndicTranscribe.from_pretrained(str(MODEL_DIR), device="cuda")
    return MODEL


def _duration_seconds(path: Path) -> float:
    info = sf.info(path)
    return round(info.frames / info.samplerate, 3)


def transcribe_file(input_path: str, output_path: str):
    """Return the raw single-model result for one private diagnostic upload."""
    started = time.monotonic()
    source, output = Path(input_path), Path(output_path)
    if not source.is_file():
        raise ValueError("Input file does not exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    model = preload_model()
    duration = _duration_seconds(source)

    if duration <= model.max_seconds:
        transcript, lid = model.transcribe(
            str(source), lang=None, mode="romanized", return_lid=True
        )
        long_form = False
    else:
        # The model's own long-form helper only creates audio-size-safe chunks.
        # It never routes languages to different engines.
        from long_form import identify_long, transcribe_long

        waveform = model._load(str(source))
        detected_language = identify_long(model, waveform)
        transcript = transcribe_long(
            model, str(source), lang=detected_language, mode="romanized"
        )
        lid = {"lang": detected_language, "source": "model-long-form-lid", "topk": []}
        long_form = True

    result = {
        "architecture": [
            "one preloaded Indic-Transcribe Flex model on the private GPU",
            "the model's built-in language decision and code-mixed decoder",
            "the model's native Romanized output mode",
            "for long recordings only: model-safe audio chunks at natural pauses, then timestamp-order merge",
        ],
        "model": "bodhan-ai/indic-transcribe-flex",
        "modelType": "single multilingual code-switch ASR",
        "outputMode": "romanized",
        "manualOrLlmEditing": False,
        "processedAt": datetime.now(timezone.utc).isoformat(),
        "processingSeconds": round(time.monotonic() - started, 3),
        "durationSeconds": duration,
        "longForm": long_form,
        "modelLanguageDecision": lid,
        "romanTranscript": transcript.strip(),
    }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result

