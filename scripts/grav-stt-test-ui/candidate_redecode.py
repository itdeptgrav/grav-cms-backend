#!/usr/bin/env python3
"""Produce independent, audio-backed ASR candidates for one suspicious span.

This is intentionally domain-neutral: no product, material, acronym or tenant
vocabulary is accepted as input. A later semantic verifier may choose only one
of the emitted candidates; it cannot author its own replacement wording.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path


SUPPORTED_LANGUAGES = ("en", "hi", "or")


def clip(source: Path, start: float, end: float, output: Path) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}",
        "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--padding", type=float, action="append", default=[2.0, 6.0, 12.0])
    args = parser.parse_args()
    if not 0 <= args.start < args.end <= args.duration:
        raise ValueError("The suspicious source span must be within the recording duration")

    import sys
    sys.path.insert(0, str(args.model_dir))
    from indic_transcribe import IndicTranscribe
    from long_form import transcribe_long

    model = IndicTranscribe.from_pretrained(str(args.model_dir), device="cuda")
    candidates = []
    with tempfile.TemporaryDirectory(prefix="grav-candidate-redecode-") as directory:
        temporary = Path(directory)
        for index, padding in enumerate(dict.fromkeys(args.padding)):
            audio_start = max(0.0, args.start - padding)
            audio_end = min(args.duration, args.end + padding)
            audio = temporary / f"candidate-{index}.wav"
            clip(args.input, audio_start, audio_end, audio)
            span_duration = audio_end - audio_start
            if span_duration <= model.max_seconds:
                text, language = model.transcribe(
                    str(audio), lang=None, allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized", return_lid=True,
                )
            else:
                probe = temporary / f"candidate-{index}-language-probe.wav"
                probe_duration = min(15.0, span_duration)
                probe_start = max(0.0, (span_duration - probe_duration) / 2)
                clip(audio, probe_start, probe_start + probe_duration, probe)
                _, language = model.transcribe(
                    str(probe), lang=None, allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized", return_lid=True,
                )
                text = transcribe_long(model, str(audio), lang=language["lang"], mode="romanized")
            candidates.append({
                "id": f"context_pad_{int(padding)}s",
                "romanText": str(text).strip(),
                "source": "same source audio, independently decoded with wider context",
                "audioStartSeconds": round(audio_start, 3),
                "audioEndSeconds": round(audio_end, 3),
                "modelLanguageDecision": language,
            })
    result = {
        "schemaVersion": "audio-candidate-redecode-v1",
        "sourceAudio": args.input.name,
        "targetStartSeconds": args.start,
        "targetEndSeconds": args.end,
        "candidates": candidates,
        "authority": "candidate text is direct ASR output; downstream models may only select candidate ids",
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"candidates": len(candidates)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
