"""GPU inference adapter. Imports heavy dependencies only on the worker."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

from .transcript_quality import SemanticReasoner, deoverlap_presentation, flags, windows


ASR_ID = "bodhan-ai/indic-transcribe-flex"
DIARIZER_ID = "nvidia/diar_sortformer_4spk-v1"
# Sortformer retains a large activation buffer while diarizing.  Bound each pass
# so a long recording does not turn a valid job into a GPU out-of-memory error.
DIARIZATION_CHUNK_SECONDS = 180.0


class InferenceError(RuntimeError):
    code = "PROCESSING_FAILED"


class AudioUnreadable(InferenceError):
    code = "AUDIO_UNREADABLE"


class ModelUnavailable(InferenceError):
    code = "MODEL_UNAVAILABLE"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class SpeechEngine:
    def __init__(self, model_dir: Path, diarizer_path: Path):
        self.model_dir = model_dir
        self.diarizer_path = diarizer_path
        self.asr = None
        self._models_verified = False
        self._verification_lock = threading.Lock()
        self._gpu_lock = threading.RLock()

    def verify_models(self) -> None:
        if self._models_verified:
            return
        with self._verification_lock:
            if self._models_verified:
                return
            if not self.model_dir.is_dir():
                raise ModelUnavailable(f"ASR model directory unavailable: {self.model_dir}")
            if not self.diarizer_path.is_file():
                raise ModelUnavailable(f"Diarizer checkpoint unavailable: {self.diarizer_path}")
            expected = os.environ.get("GRAV_SPEECH_DIARIZER_SHA256", "").strip()
            if expected and _sha256(self.diarizer_path) != expected:
                raise ModelUnavailable("Diarizer checkpoint checksum mismatch")
            self._models_verified = True

    def preload(self) -> None:
        with self._gpu_lock:
            self.verify_models()
            if self.asr is None:
                sys.path.insert(0, str(self.model_dir))
                from indic_transcribe import IndicTranscribe

                self.asr = IndicTranscribe.from_pretrained(str(self.model_dir), device="cuda")

    @staticmethod
    def _normalise(source: Path, destination: Path) -> None:
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
                 "-c:a", "pcm_s16le", str(destination)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise AudioUnreadable("Audio could not be decoded") from error

    @staticmethod
    def _clip(source: Path, start: float, end: float, destination: Path) -> None:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(source),
             "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(destination)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
        )

    @staticmethod
    def _parse_turn(value):
        if not isinstance(value, str):
            return float(value[0]), float(value[1]), int(float(value[2]))
        parts = value.strip().replace("[", "").replace("]", "").replace(",", " ").split()
        speaker = re.search(r"(\d+)$", parts[2])
        if speaker is None:
            raise InferenceError("Unrecognised diarizer output")
        return float(parts[0]), float(parts[1]), int(speaker.group(1))

    def _transcribe(self, audio: Path) -> str:
        self.preload()
        text = self.asr.transcribe(str(audio), lang=None, mode="romanized")
        if isinstance(text, tuple):
            text = text[0]
        return str(text).strip()

    def _contextual_transcript(self, source: Path, start: float, end: float, destination: Path) -> str:
        """A second bounded acoustic candidate, never a language-model edit."""
        self._clip(source, start, end, destination)
        return self._transcribe(destination)

    @staticmethod
    def _duration(audio: Path) -> float:
        with wave.open(str(audio), "rb") as source:
            return round(source.getnframes() / source.getframerate(), 3)

    def _diarize_bounded(self, diarizer, normalised: Path, duration: float, temp: Path) -> list[tuple[float, float, int]]:
        """Diarize bounded audio windows and retain original recording offsets.

        A single Sortformer request for a long file can exceed otherwise valid
        GPU memory.  Windows do not overlap, so no source audio is duplicated;
        their speaker labels are deliberately local evidence, not identities.
        """
        turns: list[tuple[float, float, int]] = []
        for chunk_index, offset in enumerate(range(0, int(duration + DIARIZATION_CHUNK_SECONDS - 1), int(DIARIZATION_CHUNK_SECONDS))):
            end = min(duration, offset + DIARIZATION_CHUNK_SECONDS)
            chunk = temp / f"diarization-{chunk_index:04d}.wav"
            self._clip(normalised, float(offset), end, chunk)
            raw_turns = diarizer.diarize(str(chunk), batch_size=1, verbose=False)[0]
            for raw in raw_turns:
                start, turn_end, speaker = self._parse_turn(raw)
                if turn_end - start >= 0.35:
                    turns.append((round(offset + start, 3), round(offset + turn_end, 3), speaker))
        turns.sort(key=lambda turn: (turn[0], turn[1], turn[2]))
        return turns

    def transcribe_utterance(self, source: Path) -> dict:
        with self._gpu_lock:
            started = time.monotonic()
            with tempfile.TemporaryDirectory(prefix="grav-speech-command-") as temporary:
                normalised = Path(temporary) / "audio.wav"
                self._normalise(source, normalised)
                duration = self._duration(normalised)
                text = self._transcribe(normalised)
            return {
                "schemaVersion": "1",
                "model": {"asr": ASR_ID, "diarizer": None},
                "manualOrLlmEditing": False,
                "processingSeconds": round(time.monotonic() - started, 3),
                "durationSeconds": duration,
                "romanTranscript": text,
            }

    def transcribe_recording(self, source: Path, *, diarization: bool, stage=None) -> dict:
        with self._gpu_lock:
            return self._transcribe_recording_locked(source, diarization=diarization, stage=stage)

    def _transcribe_recording_locked(self, source: Path, *, diarization: bool, stage=None) -> dict:
        started = time.monotonic()
        if not diarization:
            if stage:
                stage("transcribing")
            result = self.transcribe_utterance(source)
            result["processingSeconds"] = round(time.monotonic() - started, 3)
            result["speakerTurns"] = []
            result["detectedSpeakerCount"] = None
            return result

        with tempfile.TemporaryDirectory(prefix="grav-speech-recording-") as temporary:
            temp = Path(temporary)
            normalised = temp / "normalised.wav"
            self._normalise(source, normalised)
            duration = self._duration(normalised)
            if stage:
                stage("diarizing")

            # The validated 16 GB path cannot retain both large models. End every
            # job with Flex warm because command traffic has priority.
            if self.asr is not None:
                del self.asr
                self.asr = None
            import torch
            from nemo.collections.asr.models import SortformerEncLabelModel

            diarizer = SortformerEncLabelModel.restore_from(
                restore_path=str(self.diarizer_path), map_location="cuda"
            )
            turns = self._diarize_bounded(diarizer, normalised, duration, temp)
            del diarizer
            torch.cuda.empty_cache()
            if stage:
                stage("transcribing")
            self.preload()
            labelled = []
            for index, (start, end, speaker) in enumerate(turns):
                clip = temp / f"turn-{index:04d}.wav"
                self._clip(normalised, start, end, clip)
                labelled.append({
                    "index": index,
                    "speaker": f"Speaker {speaker + 1}",
                    "startSeconds": round(start, 3),
                    "endSeconds": round(end, 3),
                    "romanText": self._transcribe(clip),
                })

            # Schema v2 retains the original ASR evidence and introduces a
            # separate presentation candidate. A semantic verifier can only
            # trigger another audio decode or choose an existing candidate.
            for turn in labelled:
                turn["rawRomanText"] = turn["romanText"]
                turn["qualityFlags"] = flags(
                    turn["rawRomanText"], float(turn["endSeconds"]) - float(turn["startSeconds"])
                )
            reviews = windows(labelled)
            for review in reviews:
                review["candidateTranscripts"] = [{
                    "id": "raw_turn_concat", "romanText": review["rawRomanText"],
                    "source": "timestamp ordered raw diarizer turns",
                }]
            reasoner = SemanticReasoner()
            semantic_error = None
            try:
                initial_reviews = reasoner.review(reviews)
            except Exception as error:
                initial_reviews = {}
                semantic_error = type(error).__name__
            recovery_ids = set()
            for review in reviews:
                semantic = initial_reviews.get(review["id"])
                if semantic:
                    review["semanticReview"] = semantic
                if review["qualityFlags"] or semantic and (
                    semantic.get("recoveryRequired") or semantic.get("semanticIssues")
                ):
                    recovery_ids.add(review["id"])
            for review in reviews:
                if review["id"] not in recovery_ids:
                    continue
                start = max(0.0, float(review["startSeconds"]) - 1.5)
                end = min(duration, float(review["endSeconds"]) + 1.5)
                # Avoid sending an unsafe long context directly to the model.
                if end - start > 28.0:
                    continue
                context_audio = temp / f"{review['id']}-context.wav"
                recovered = self._contextual_transcript(normalised, start, end, context_audio)
                review["candidateTranscripts"].append({
                    "id": "contextual_redecode", "romanText": recovered,
                    "source": "same source audio with contextual padding",
                    "audioStartSeconds": round(start, 3), "audioEndSeconds": round(end, 3),
                })
            try:
                final_reviews = reasoner.review(reviews) if recovery_ids else initial_reviews
            except Exception as error:
                final_reviews = initial_reviews
                semantic_error = type(error).__name__
            for review in reviews:
                candidates = {candidate["id"]: candidate for candidate in review["candidateTranscripts"]}
                semantic = final_reviews.get(review["id"], review.get("semanticReview", {}))
                selected = semantic.get("selectedCandidateId") if semantic else None
                review["selectedCandidateId"] = selected if selected in candidates else "raw_turn_concat"
                review["selectedRomanText"] = candidates[review["selectedCandidateId"]]["romanText"]
                review["semanticReview"] = semantic or None
                review["trustedForReadableTranscript"] = bool(
                    semantic and semantic.get("state") == "coherent" and not review["qualityFlags"]
                )
            deoverlap_presentation(reviews)

        return {
            "schemaVersion": "2",
            "model": {"asr": ASR_ID, "diarizer": DIARIZER_ID},
            "manualOrLlmEditing": False,
            "processingSeconds": round(time.monotonic() - started, 3),
            "durationSeconds": duration,
            "detectedSpeakerCount": len({turn["speaker"] for turn in labelled}),
            "speakerTurns": labelled,
            "utteranceReviews": reviews,
            "semanticReasoner": {
                "enabled": reasoner.enabled, "model": reasoner.model if reasoner.enabled else None,
                "errorClass": semantic_error,
                "authority": "candidate selection and recovery trigger only; never transcript authoring",
            },
            "romanTranscript": " ".join(
                review["presentationRomanText"] for review in reviews
                if review["trustedForReadableTranscript"]
            ).strip(),
        }
