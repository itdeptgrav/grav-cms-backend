#!/usr/bin/env python3
"""Decode a recording in overlapping, model-safe context windows.

This is intentionally separate from diarization.  Speaker segmentation is a
useful attribution signal, but cutting first can erase the phonetic context
needed for business names, code-switched speech and quantities.  Each emitted
line remains an exact ASR decode of its bounded audio window.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


SUPPORTED_LANGUAGES = ("en", "hi", "or")


def clip(source: Path, start: float, duration: float, output: Path) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
        "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", str(output),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def has_repetition_collapse(text: str) -> bool:
    """Identify decoder loops, not normal repeated business terms.

    The model occasionally continues a short number phrase until its token
    budget is consumed.  That is a decoding failure, so we retry the *audio*
    in smaller windows rather than correcting words after the fact.
    """
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    if len(tokens) < 20:
        return False
    highest = max(tokens.count(token) for token in set(tokens))
    if highest / len(tokens) >= 0.22:
        return True
    phrases = [" ".join(tokens[index:index + 3]) for index in range(len(tokens) - 2)]
    return bool(phrases) and max(phrases.count(phrase) for phrase in set(phrases)) >= 4


def decode_window(model, source: Path, start: float, duration: float, temporary_path: Path, index: str, language: str | None):
    audio = temporary_path / f"window-{index}.wav"
    clip(source, start, duration, audio)
    text, language_decision = model.transcribe(
        str(audio),
        lang=language,
        allowed_langs=SUPPORTED_LANGUAGES,
        mode="romanized",
        return_lid=True,
    )
    return str(text).strip(), language_decision


def checkpoint(output: Path, rows: list[dict], *, complete: bool) -> None:
    """Persist valid JSON after each window so long recordings are observable."""
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".partial")
    temporary.write_text(json.dumps({"windows": rows, "complete": complete}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--window", type=float, default=34)
    parser.add_argument("--stride", type=float, default=32)
    parser.add_argument("--language", help="Known recording language, for example hi; bypasses unreliable automatic LID.")
    args = parser.parse_args()

    sys.path.insert(0, str(args.model_dir))
    from indic_transcribe import IndicTranscribe

    model = IndicTranscribe.from_pretrained(str(args.model_dir), device="cuda")
    rows = []
    with tempfile.TemporaryDirectory(prefix="grav-contextual-") as temporary:
        temporary_path = Path(temporary)
        start = args.start
        index = 0
        while start < args.end:
            duration = min(args.window, args.end - start)
            text, language = decode_window(model, args.input, start, duration, temporary_path, f"{index:03d}", args.language)
            if has_repetition_collapse(text) and duration > 18:
                # Preserve acoustic context while staying far below the model's
                # unstable length.  The overlap is handled downstream by exact
                # boundary matching only.
                retry_duration = duration / 2 + 1
                for retry in range(2):
                    retry_start = start + retry * (duration / 2 - 1)
                    retry_end = min(retry_start + retry_duration, args.end)
                    retry_text, retry_language = decode_window(
                        model, args.input, retry_start,
                        retry_end - retry_start,
                        temporary_path, f"{index:03d}-retry-{retry}", args.language,
                    )
                    if has_repetition_collapse(retry_text) and retry_end - retry_start > 11:
                        # A second loop means the acoustic content is dense or
                        # noisy. Decode that exact range in 10-second windows.
                        micro_start = retry_start
                        micro_index = 0
                        while micro_start < retry_end:
                            micro_end = min(micro_start + 10, retry_end)
                            micro_text, micro_language = decode_window(
                                model, args.input, micro_start, micro_end - micro_start,
                                temporary_path, f"{index:03d}-retry-{retry}-micro-{micro_index}", args.language,
                            )
                            rows.append({
                                "startSeconds": round(micro_start, 3),
                                "endSeconds": round(micro_end, 3),
                                "romanText": micro_text,
                                "modelLanguageDecision": micro_language,
                                "source": "micro-window retry after repeated decoder collapse",
                            })
                            micro_start += 8
                            micro_index += 1
                    else:
                        rows.append({
                            "startSeconds": round(retry_start, 3),
                            "endSeconds": round(retry_end, 3),
                            "romanText": retry_text,
                            "modelLanguageDecision": retry_language,
                            "source": "shorter retry after repetition-collapse detection",
                        })
            else:
                rows.append({
                    "startSeconds": round(start, 3),
                    "endSeconds": round(start + duration, 3),
                    "romanText": text,
                    "modelLanguageDecision": language,
                    "source": "overlapping model-safe audio window",
                })
            start += args.stride
            index += 1
            checkpoint(args.output, rows, complete=False)
    checkpoint(args.output, rows, complete=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
