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


ASR_ID = "bodhan-ai/indic-transcribe-flex"
DIARIZER_ID = "nvidia/diar_sortformer_4spk-v1"


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

    @staticmethod
    def _duration(audio: Path) -> float:
        with wave.open(str(audio), "rb") as source:
            return round(source.getnframes() / source.getframerate(), 3)

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
            raw_turns = diarizer.diarize(str(normalised), batch_size=1, verbose=False)[0]
            turns = []
            for raw in raw_turns:
                start, end, speaker = self._parse_turn(raw)
                if end - start >= 0.35:
                    turns.append((start, end, speaker))
            turns.sort(key=lambda turn: (turn[0], turn[1], turn[2]))
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

        return {
            "schemaVersion": "1",
            "model": {"asr": ASR_ID, "diarizer": DIARIZER_ID},
            "manualOrLlmEditing": False,
            "processingSeconds": round(time.monotonic() - started, 3),
            "durationSeconds": duration,
            "detectedSpeakerCount": len({turn["speaker"] for turn in labelled}),
            "speakerTurns": labelled,
            "romanTranscript": " ".join(turn["romanText"] for turn in labelled).strip(),
        }
