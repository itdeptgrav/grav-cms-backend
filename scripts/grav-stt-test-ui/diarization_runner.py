#!/usr/bin/env python3
"""Speaker-labelled, Romanized transcription for the GRAV Voice prototype.

The tested pipeline is deliberately deterministic: NVIDIA Sortformer supplies
speaker turns, Indic-Transcribe Flex transcribes each turn, and timestamps are
sorted without rewriting any model text.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import torch
from nemo.collections.asr.models import SortformerEncLabelModel

DEFAULT_MODEL_DIR = Path(os.environ.get("GRAV_STT_MODEL_DIR", "/root/indic-transcribe-flex"))
DEFAULT_DIARIZER = os.environ.get("GRAV_DIARIZER_MODEL", "nvidia/diar_sortformer_4spk-v1")


def _normalise(source: Path, destination: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", str(destination),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )


def _parse_turn(value):
    if not isinstance(value, str):
        return float(value[0]), float(value[1]), int(float(value[2]))
    parts = value.strip().replace("[", "").replace("]", "").replace(",", " ").split()
    speaker = re.search(r"(\d+)$", parts[2])
    if speaker is None:
        raise ValueError(f"Unrecognised NeMo speaker label: {parts[2]!r}")
    return float(parts[0]), float(parts[1]), int(speaker.group(1))


def _clip(source: Path, start: float, end: float, destination: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
            "-i", str(source), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            str(destination),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )


def run(input_path: Path, output_path: Path, model_dir: Path, diarizer_source: str) -> dict:
    started = time.monotonic()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="grav-diarization-") as temporary:
        temp = Path(temporary)
        normalised = temp / "normalised.wav"
        _normalise(input_path, normalised)

        diarizer_path = Path(diarizer_source)
        if diarizer_path.is_file():
            diarizer = SortformerEncLabelModel.restore_from(
                restore_path=str(diarizer_path), map_location="cuda"
            )
        else:
            diarizer = SortformerEncLabelModel.from_pretrained(
                diarizer_source, map_location="cuda"
            )
        raw_turns = diarizer.diarize(str(normalised), batch_size=1, verbose=False)[0]
        turns = []
        for raw_turn in raw_turns:
            start, end, speaker = _parse_turn(raw_turn)
            if end - start >= 0.35:
                turns.append((start, end, speaker))
        turns.sort(key=lambda turn: (turn[0], turn[1], turn[2]))
        del diarizer
        torch.cuda.empty_cache()

        sys.path.insert(0, str(model_dir))
        from indic_transcribe import IndicTranscribe

        asr = IndicTranscribe.from_pretrained(str(model_dir), device="cuda")
        labelled_turns = []
        for index, (start, end, speaker) in enumerate(turns):
            turn_audio = temp / f"turn-{index:03d}.wav"
            _clip(normalised, start, end, turn_audio)
            text = asr.transcribe(str(turn_audio), lang=None, mode="romanized")
            if isinstance(text, tuple):
                text = text[0]
            labelled_turns.append(
                {
                    "index": index,
                    "speaker": f"Speaker {speaker + 1}",
                    "startSeconds": round(start, 3),
                    "endSeconds": round(end, 3),
                    "durationSeconds": round(end - start, 3),
                    "engine": "bodhan-ai/indic-transcribe-flex",
                    "romanText": text,
                }
            )

    result = {
        "sourceFile": input_path.name,
        "architecture": [
            f"{diarizer_source} offline speaker diarization",
            "per-diarized-turn bodhan-ai/indic-transcribe-flex Romanized ASR",
            "timestamp-ordered raw speaker-labelled output",
        ],
        "manualOrLlmEditing": False,
        "processingSeconds": round(time.monotonic() - started, 3),
        "detectedSpeakerCount": len({turn["speaker"] for turn in labelled_turns}),
        "speakerTurns": labelled_turns,
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--diarizer", default=DEFAULT_DIARIZER)
    args = parser.parse_args()
    print(json.dumps(run(args.input.resolve(), args.output.resolve(), args.model_dir, args.diarizer),
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
