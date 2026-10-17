#!/usr/bin/env python3
"""Speaker-labelled, evidence-preserving transcription for GRAV Voice.

The tested pipeline is deliberately deterministic: NVIDIA Sortformer supplies
speaker turns, Indic-Transcribe Flex transcribes each turn, and timestamps are
sorted without rewriting any model text.  Deterministic and optional semantic
quality gates may mark output uncertain; neither gate may rewrite it.
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
import site
from pathlib import Path

# The deployed ASR runtime and the diarizer can live in separate environments.
# Add the latter after the active environment so its NeMo package is available
# without replacing the active runtime's compatible Transformers version.
_DIARIZER_SITE_PACKAGES = os.environ.get("GRAV_DIARIZER_SITE_PACKAGES", "").strip()
if _DIARIZER_SITE_PACKAGES:
    site.addsitedir(_DIARIZER_SITE_PACKAGES)

import torch
from nemo.collections.asr.models import SortformerEncLabelModel

DEFAULT_MODEL_DIR = Path(os.environ.get("GRAV_STT_MODEL_DIR", "/root/indic-transcribe-flex"))
DEFAULT_DIARIZER = os.environ.get("GRAV_DIARIZER_MODEL", "nvidia/diar_sortformer_4spk-v1")
SUPPORTED_LANGUAGES = tuple(
    value.strip() for value in os.environ.get("GRAV_STT_ALLOWED_LANGUAGES", "en,hi,or").split(",")
    if value.strip()
)
RECOVERY_PAD_SECONDS = float(os.environ.get("GRAV_TRANSCRIPT_RECOVERY_PAD_SECONDS", "1.5"))


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


def run(
    input_path: Path,
    output_path: Path,
    model_dir: Path,
    diarizer_source: str,
    domain_terms: list[str] | None = None,
) -> dict:
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
        from long_form import transcribe_long

        from transcript_quality import (
            add_speaker_evidence, build_utterance_windows, deterministic_flags, numeric_evidence,
        )
        from transcript_reasoner import TranscriptReasoner, reasoner_packets

        asr = IndicTranscribe.from_pretrained(str(model_dir), device="cuda")
        labelled_turns = []
        for index, (start, end, speaker) in enumerate(turns):
            turn_audio = temp / f"turn-{index:03d}.wav"
            _clip(normalised, start, end, turn_audio)
            duration = end - start
            if duration > asr.max_seconds:
                # The base decoder is unsafe beyond its trained context and can
                # collapse into repeated words.  Its own helper splits only at
                # audio pauses and preserves model text.
                probe_audio = temp / f"turn-{index:03d}-language-probe.wav"
                probe_duration = min(duration, 15.0)
                probe_start = max(0.0, (duration - probe_duration) / 2)
                _clip(turn_audio, probe_start, probe_start + probe_duration, probe_audio)
                _, lid = asr.transcribe(
                    str(probe_audio),
                    lang=None,
                    allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized",
                    return_lid=True,
                )
                text = transcribe_long(
                    asr, str(turn_audio), lang=lid["lang"], mode="romanized"
                )
                lid["source"] = "supported-language-midpoint-probe"
            else:
                text, lid = asr.transcribe(
                    str(turn_audio),
                    lang=None,
                    allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized",
                    return_lid=True,
                )
            raw_text = str(text).strip()
            quality_flags = deterministic_flags(raw_text, duration)
            labelled_turns.append(
                {
                    "index": index,
                    "speaker": f"Speaker {speaker + 1}",
                    "startSeconds": round(start, 3),
                    "endSeconds": round(end, 3),
                    "durationSeconds": round(duration, 3),
                    "engine": "bodhan-ai/indic-transcribe-flex",
                    "rawRomanText": raw_text,
                    # Kept temporarily for consumers of schema v1. It is an
                    # exact alias, never a cleaned or reasoner-written value.
                    "romanText": raw_text,
                    "modelLanguageDecision": lid,
                    "qualityState": "uncertain" if quality_flags else "unverified",
                    "qualityFlags": quality_flags,
                }
            )

        speaker_evidence = add_speaker_evidence(labelled_turns)
        utterance_reviews = build_utterance_windows(labelled_turns)
        for utterance in utterance_reviews:
            utterance["candidateTranscripts"] = [{
                "id": "raw_turn_concat",
                "romanText": utterance["rawRomanText"],
                "source": "timestamp-ordered raw diarizer turns",
                "qualityFlags": list(utterance["qualityFlags"]),
            }]
            # Numbers are high-risk facts. Seed their flags before the first
            # reasoner pass so "point five" receives contextual recovery too.
            utterance["numericEvidence"] = numeric_evidence(utterance["candidateTranscripts"])
            utterance["qualityFlags"] = sorted(set(
                utterance["qualityFlags"] + utterance["numericEvidence"]["flags"]
            ))
        reasoner = TranscriptReasoner(domain_terms=domain_terms)
        reasoner_error = None
        reviews_by_id = {}
        if reasoner.enabled:
            try:
                for packet in reasoner_packets(utterance_reviews, domain_terms=reasoner.domain_terms):
                    for review in reasoner.review(packet):
                        reviews_by_id[review["id"]] = review
            except Exception as error:  # Raw transcript remains usable/auditable.
                reasoner_error = type(error).__name__

        for utterance in utterance_reviews:
            review = reviews_by_id.get(utterance["id"])
            if review:
                utterance["semanticReview"] = review
                utterance["qualityState"] = review["state"]

        # Recovery is acoustic, not generative: re-cut a suspicious collection
        # of tiny turns as one utterance and ask ASR again with proper context.
        recovery_ids = {
            utterance["id"] for utterance in utterance_reviews
            if utterance["qualityFlags"]
            or utterance.get("semanticReview", {}).get("state") in {"uncertain", "gibberish"}
            or utterance.get("semanticReview", {}).get("recoveryRequired", False)
            or utterance.get("semanticReview", {}).get("semanticIssues")
        }
        for utterance in utterance_reviews:
            if utterance["id"] not in recovery_ids:
                continue
            recovery_audio = temp / f"{utterance['id']}-context.wav"
            # A substantive margin lets ASR hear the word boundary that a
            # diarizer may have cut too tightly. The recovered text remains a
            # separate, fully auditable candidate rather than an edit.
            recovery_start = max(0.0, float(utterance["startSeconds"]) - RECOVERY_PAD_SECONDS)
            recovery_end = float(utterance["endSeconds"]) + RECOVERY_PAD_SECONDS
            _clip(normalised, recovery_start, recovery_end, recovery_audio)
            recovery_duration = recovery_end - recovery_start
            if recovery_duration <= asr.max_seconds:
                recovery_text, recovery_lid = asr.transcribe(
                    str(recovery_audio), lang=None, allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized", return_lid=True,
                )
            else:
                recovery_probe = temp / f"{utterance['id']}-language-probe.wav"
                probe_duration = min(recovery_duration, 15.0)
                probe_start = max(0.0, (recovery_duration - probe_duration) / 2)
                _clip(recovery_audio, probe_start, probe_start + probe_duration, recovery_probe)
                _, recovery_lid = asr.transcribe(
                    str(recovery_probe), lang=None, allowed_langs=SUPPORTED_LANGUAGES,
                    mode="romanized", return_lid=True,
                )
                recovery_text = transcribe_long(
                    asr, str(recovery_audio), lang=recovery_lid["lang"], mode="romanized"
                )
            utterance["candidateTranscripts"].append({
                "id": "contextual_redecode",
                "romanText": str(recovery_text).strip(),
                "source": "same bounded audio re-cut as one contextual utterance",
                "audioStartSeconds": round(recovery_start, 3),
                "audioEndSeconds": round(recovery_end, 3),
                "modelLanguageDecision": recovery_lid,
                "qualityFlags": deterministic_flags(
                    str(recovery_text).strip(), recovery_duration
                ),
            })

        for utterance in utterance_reviews:
            utterance["numericEvidence"] = numeric_evidence(utterance["candidateTranscripts"])
            utterance["qualityFlags"] = sorted(set(
                utterance["qualityFlags"] + utterance["numericEvidence"]["flags"]
            ))

        # A second semantic pass may select an ASR candidate verbatim. It still
        # has no authority to author replacement text.
        if reasoner.enabled and recovery_ids and reasoner_error is None:
            try:
                for packet in reasoner_packets(
                    utterance_reviews, selected_ids=recovery_ids, domain_terms=reasoner.domain_terms
                ):
                    for review in reasoner.review(packet):
                        reviews_by_id[review["id"]] = review
            except Exception as error:
                reasoner_error = type(error).__name__

        for utterance in utterance_reviews:
            review = reviews_by_id.get(utterance["id"])
            candidates = {candidate["id"]: candidate for candidate in utterance["candidateTranscripts"]}
            selected_id = review.get("selectedCandidateId") if review else None
            if selected_id not in candidates:
                selected_id = min(
                    candidates,
                    key=lambda candidate_id: (
                        len(candidates[candidate_id].get("qualityFlags", [])),
                        candidate_id != "contextual_redecode",
                    ),
                )
            utterance["selectedCandidateId"] = selected_id
            utterance["selectedRomanText"] = candidates[selected_id]["romanText"]
            if review:
                utterance["semanticReview"] = review
                utterance["qualityState"] = review["state"]
            utterance["trustedForReadableTranscript"] = (
                (utterance["qualityState"] == "coherent" if reasoner.enabled else not utterance["qualityFlags"])
                and utterance["numericEvidence"]["safeForStructuredFacts"]
                and selected_id in candidates
            )
            utterance["safeForStructuredFacts"] = (
                utterance["trustedForReadableTranscript"]
                and utterance["numericEvidence"]["safeForStructuredFacts"]
            )

    result = {
        "sourceFile": input_path.name,
        "schemaVersion": "2",
        "architecture": [
            f"{diarizer_source} offline speaker diarization",
            "model-safe bodhan-ai/indic-transcribe-flex Romanized ASR with supported-language constraint",
            "timestamp-ordered raw speaker-labelled output preserved as evidence",
            "deterministic audio/decode quality gate",
            "optional private semantic verifier that classifies but never rewrites",
        ],
        "manualOrLlmEditing": False,
        "processingSeconds": round(time.monotonic() - started, 3),
        "detectedSpeakerCount": len({turn["speaker"] for turn in labelled_turns}),
        "speakerEvidence": speaker_evidence,
        "speakerTurns": labelled_turns,
        "utteranceReviews": utterance_reviews,
        "semanticReasoner": {
            "enabled": reasoner.enabled,
            "model": reasoner.model if reasoner.enabled else None,
            "status": "failed" if reasoner_error else ("completed" if reasoner.enabled else "disabled"),
            "errorClass": reasoner_error,
            "authority": "quality classification only; no transcript rewrite",
        },
        "presentationPolicy": "Never merge or render an utterance as trusted prose when trustedForReadableTranscript is false.",
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--diarizer", default=DEFAULT_DIARIZER)
    parser.add_argument(
        "--domain-term", action="append", default=[],
        help="Tenant vocabulary hint for semantic recovery; never inserted as transcript text.",
    )
    args = parser.parse_args()
    print(json.dumps(run(
        args.input.resolve(), args.output.resolve(), args.model_dir, args.diarizer, args.domain_term
    ),
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
