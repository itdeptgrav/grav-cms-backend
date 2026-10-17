#!/usr/bin/env python3
"""Create one independent ASR candidate per flagged span, loading ASR once.

The plan contains timestamps only.  No phrase, topic, tenant, or target word is
accepted by this tool; every candidate is emitted from the original audio.
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
    parser.add_argument("plan", type=Path, help="JSON array with id, startSeconds and endSeconds")
    parser.add_argument("output", type=Path)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument(
        "--padding", type=float, action="append", default=[],
        help="Context padding in seconds; repeat to create independent, wider-context candidates.",
    )
    parser.add_argument(
        "--language", action="append", default=[], choices=SUPPORTED_LANGUAGES,
        help="Optional language-constrained ASR variants; repeat to create multiple candidates.",
    )
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if not isinstance(plan, list):
        raise ValueError("plan must be a JSON array")

    import sys
    sys.path.insert(0, str(args.model_dir))
    from indic_transcribe import IndicTranscribe
    from long_form import transcribe_long

    model = IndicTranscribe.from_pretrained(str(args.model_dir), device="cuda")
    paddings = args.padding or [12.0]
    if any(padding < 0 for padding in paddings):
        raise ValueError("padding must not be negative")
    recovered = []
    with tempfile.TemporaryDirectory(prefix="grav-batch-redecode-") as directory:
        temporary = Path(directory)
        for index, span in enumerate(plan):
            start = float(span["startSeconds"])
            end = float(span["endSeconds"])
            if not 0 <= start < end <= args.duration:
                raise ValueError(f"invalid source span {span.get('id', index)}")
            variants = []
            for padding in dict.fromkeys(paddings):
                audio_start = max(0.0, start - padding)
                audio_end = min(args.duration, end + padding)
                audio = temporary / f"span-{index}-pad-{padding:g}.wav"
                clip(args.input, audio_start, audio_end, audio)
                span_duration = audio_end - audio_start
                probe = temporary / f"span-{index}-pad-{padding:g}-language-probe.wav"
                probe_duration = min(15.0, span_duration)
                probe_start = max(0.0, (span_duration - probe_duration) / 2)
                clip(audio, probe_start, probe_start + probe_duration, probe)
                _, detected_language = model.transcribe(
                    str(probe), lang=None, allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized", return_lid=True,
                )
                languages = args.language or [detected_language["lang"]]
                for language_code in dict.fromkeys(languages):
                    if span_duration <= model.max_seconds:
                        text, _ = model.transcribe(
                            str(audio), lang=language_code, mode="romanized", return_lid=True,
                        )
                    else:
                        text = transcribe_long(model, str(audio), lang=language_code, mode="romanized")
                    variants.append({
                        "id": f"context_pad_{padding:g}s_{language_code}",
                        "romanText": str(text).strip(),
                        "source": "same source audio, independently decoded with timestamp-only context padding",
                        "audioStartSeconds": round(audio_start, 3),
                        "audioEndSeconds": round(audio_end, 3),
                        "contextPaddingSeconds": padding,
                        "modelLanguageDecision": detected_language,
                        "forcedLanguage": language_code,
                    })
            recovered.append({
                "id": str(span.get("id") or f"span-{index}"),
                "targetStartSeconds": start,
                "targetEndSeconds": end,
                "candidates": variants,
            })
    args.output.write_text(json.dumps({
        "schemaVersion": "batch-audio-candidate-redecode-v1",
        "candidates": recovered,
        "authority": "timestamps only; candidates are exact ASR output from source audio",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"spans": len(recovered)}))


if __name__ == "__main__":
    raise SystemExit(main())
