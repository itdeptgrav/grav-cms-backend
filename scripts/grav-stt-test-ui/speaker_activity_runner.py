#!/usr/bin/env python3
"""Run diarization independently of transcription.

This is the second stage of the GRAV recording pipeline.  It produces only
speaker-time activity and deliberately does not segment audio before ASR.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

from nemo.collections.asr.models import SortformerEncLabelModel


def parse_turn(value):
    if not isinstance(value, str):
        return float(value[0]), float(value[1]), int(float(value[2]))
    parts = value.strip().replace("[", "").replace("]", "").replace(",", " ").split()
    match = re.search(r"(\d+)$", parts[2])
    if match is None:
        raise ValueError(f"Unrecognised diarizer label: {value!r}")
    return float(parts[0]), float(parts[1]), int(match.group(1))


def duration_seconds(path: Path) -> float:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(completed.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--chunk-seconds", type=float, default=180)
    args = parser.parse_args()

    diarizer = SortformerEncLabelModel.restore_from(str(args.model), map_location="cuda")
    turns = []
    total = duration_seconds(args.input)
    with tempfile.TemporaryDirectory(prefix="grav-speaker-activity-") as directory:
        directory_path = Path(directory)
        chunk_start = 0.0
        index = 0
        while chunk_start < total:
            chunk_length = min(args.chunk_seconds, total - chunk_start)
            audio = directory_path / f"audio-{index:03d}.wav"
            subprocess.run([
                "ffmpeg", "-y", "-ss", f"{chunk_start:.3f}", "-t", f"{chunk_length:.3f}", "-i", str(args.input),
                "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            for raw in diarizer.diarize(str(audio), batch_size=1, verbose=False)[0]:
                start, end, speaker = parse_turn(raw)
                if end - start >= 0.35:
                    turns.append({
                        "startSeconds": round(chunk_start + start, 3),
                        "endSeconds": round(chunk_start + end, 3),
                        "speaker": f"Speaker {speaker + 1}",
                    })
            audio.unlink(missing_ok=True)
            chunk_start += args.chunk_seconds
            index += 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"speakerTurns": turns}, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
