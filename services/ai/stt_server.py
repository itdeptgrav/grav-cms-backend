#!/usr/bin/env python3
"""
GRAV local speech-to-text server (faster-whisper).

Runs 100% offline on this machine -- audio never leaves the host. It exists to
replace the browser's Web Speech API for the GRAV assistant's *command* capture,
which mangled Indian-accented English + business jargon ("ledger balance of
Mayfair" -> "leatherbalance of maker Hotel Run"). Whisper is far stronger there.

Contract (kept deliberately tiny, localhost-only, no auth -- the Node backend at
:5050 is the only caller and proxies to it):

  GET  /health              -> {"ok": true, "model": "<name>"}
  POST /transcribe          -> {"text": "<transcript>"}
     body:   raw audio bytes (webm/opus/ogg/wav/m4a -- decoded via PyAV/ffmpeg)
     header: X-Hotwords   optional. A short, comma/space list of domain terms
             (ledger names, party names, employee names, account groups) the
             backend builds from the live DB. Whisper is biased toward these so
             real names transcribe correctly at the source.

Config via env:
  GRAV_STT_MODEL    faster-whisper model id      (default: small.en)
  GRAV_STT_PORT     port to listen on            (default: 5060)
  GRAV_STT_COMPUTE  ctranslate2 compute type     (default: int8)
"""

import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("GRAV_STT_MODEL", "small.en")
# NOTE: not 5060/5061 — those are on the Fetch spec's blocked-ports list (SIP), so
# Node's fetch and browsers refuse to connect (curl doesn't care, which masked it).
PORT = int(os.environ.get("GRAV_STT_PORT", "5757"))
COMPUTE = os.environ.get("GRAV_STT_COMPUTE", "int8")

# (Domain terms are no longer injected as a prompt — that fueled the echo/repeat
# hallucination. Domain-word fixups happen in the backend's transcriptCorrect.js.)

print(f"[grav-stt] loading model '{MODEL_NAME}' (compute={COMPUTE}) ...", flush=True)
model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE)
_lock = threading.Lock()  # CTranslate2 model is not safe for concurrent decode
print(f"[grav-stt] model ready, listening on 127.0.0.1:{PORT}", flush=True)


# Names are biased via the lighter `hotwords` parameter, NOT stuffed into
# initial_prompt — a long name list in the prompt made Whisper ECHO those names in
# a repetition loop on unclear/short audio ("MAYFAIR on Sea Gopalpur" ×50). We cap
# it short and lean on the backend's fuzzy ledger/name resolution for the rest.
HOTWORDS_MAX = 350


def cap_hotwords(hotwords: str) -> str:
    hot = (hotwords or "").strip()
    return hot[:HOTWORDS_MAX] if hot else ""


def _looks_hallucinated(text: str) -> bool:
    # Whisper hallucination = the same word/phrase over and over. Very low unique
    # ratio over a non-trivial length -> junk; drop it entirely.
    words = re.findall(r"[A-Za-z]+", text)
    if len(words) >= 6:
        uniq = len(set(w.lower() for w in words))
        if uniq / len(words) < 0.4:
            return True
    return False


def _collapse_repeats(text: str) -> str:
    # Light de-dup for the survivors: "A, A, A" -> "A", "PRABHU PRABHU" -> "PRABHU".
    parts = [p.strip() for p in text.split(",")]
    out = []
    for p in parts:
        if p and (not out or out[-1].lower() != p.lower()):
            out.append(p)
    text = ", ".join(out)
    text = re.sub(r"\b(\w[\w&.'-]*)(\s+\1\b)+", r"\1", text, flags=re.IGNORECASE)
    return text.strip(" ,")


def transcribe(audio_bytes: bytes, hotwords: str) -> str:
    suffix = ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        path = tmp.name
    try:
        with _lock:
            segments, _info = model.transcribe(
                path,
                language="en",
                beam_size=5,
                vad_filter=True,  # drop silence -> faster + cleaner
                vad_parameters={"min_silence_duration_ms": 500},
                hotwords=cap_hotwords(hotwords) or None,
                initial_prompt=None,
                condition_on_previous_text=False,  # each turn is independent
                # Anti-hallucination: stop repeat loops at decode time and drop
                # low-confidence / silent / gibberish segments.
                no_repeat_ngram_size=3,
                repetition_penalty=1.15,
                compression_ratio_threshold=2.2,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
                temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            )
            raw = "".join(seg.text for seg in segments).strip()
        if _looks_hallucinated(raw):
            return ""  # better to hear nothing than a wall of repeated names
        return _collapse_repeats(raw)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL_NAME})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                self._send(400, {"error": "empty body"})
                return
            audio = self.rfile.read(length)
            hotwords = self.headers.get("X-Hotwords", "")
            text = transcribe(audio, hotwords)
            self._send(200, {"text": text})
        except Exception as exc:  # noqa: BLE001 -- report, keep serving
            sys.stderr.write(f"[grav-stt] transcribe error: {exc}\n")
            sys.stderr.flush()
            self._send(500, {"error": str(exc)})

    def log_message(self, *_args):  # silence default per-request stderr spam
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
