#!/usr/bin/env python3
"""
GRAV voice speech-to-text on the RunPod GPU — Indic-Transcribe-Flex
(Bodhan AI / AI4Bharat), for "Hey GRAV" and the mic in Cmd/Ctrl K.

Same tiny contract as the Mac's Whisper sidecar (services/ai/stt_server.py in
grav-cms-backend), so the backend can call either:

  GET  /health      -> {"ok": true, "model": "indic-transcribe-flex", "device": "cuda"}
  POST /transcribe  -> {"text": "...", "lang": "en", "ms": 300}
       body: raw audio bytes in any container ffmpeg reads (webm/opus, mp4/aac, wav)
       headers (optional): X-Lang (default "en"), X-Mode (default "mixed");
       X-Langs "en,hi,or" → English, Hindi or Odia: {"text": <English>, "lang",
       "original": <what was said, in its script>} (translation: indic_mt_server.py)

Listens on 127.0.0.1 ONLY. The GRAV backend reaches it through an SSH tunnel
from the Mac; nothing is exposed on the pod's public ports. One clip at a
time on the GPU; clips are short spoken commands (capped at 30 s).

Defaults, measured on this pod (RTX 2000 Ada, 0.2–0.5 s a command): the
language is GIVEN, English, because the model's own identification is weakest
for Hindi (its docstring: top-1 0.258 for hi) and a wrong guess turned "show
me" into "show mein" and a code into "Saat". Mode "mixed" keeps digits as
digits ("3rd October"). Codes spoken digit by digit ("GR zero zero six
seven") are joined back ("GR0067"). X-Lang / X-Mode override per request.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import re
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_DIR = os.environ.get("GRAV_INDIC_MODEL_DIR", "/root/indic-transcribe-flex")
PORT = int(os.environ.get("GRAV_INDIC_PORT", "19057"))
MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 30

sys.path.insert(0, MODEL_DIR)
from indic_transcribe import IndicTranscribe  # noqa: E402

print(f"[grav-indic-stt] loading {MODEL_DIR} on cuda ...", flush=True)
t0 = time.time()
ASR = IndicTranscribe.from_pretrained(MODEL_DIR, device="cuda")
LOCK = threading.Lock()

# ── WARM BEFORE READY ──────────────────────────────────────────────────────
# The first clip after loading came back wrong ("Saat", "67" for "show me
# GR0067") while the same clip warm is exact, every time. So two throwaway
# transcriptions run before /health says ready.
_warm = tempfile.NamedTemporaryFile(delete=False, suffix=".wav").name
subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                "sine=frequency=220:duration=1.5", "-ac", "1", "-ar", "16000", _warm], check=True)
for _ in range(2):
    ASR.transcribe(_warm, lang="en", mode="mixed")
os.unlink(_warm)
print(f"[grav-indic-stt] ready in {time.time() - t0:.1f}s on 127.0.0.1:{PORT}", flush=True)


DIGITS = {"zero": "0", "oh": "0", "o": "0", "one": "1", "two": "2", "three": "3", "four": "4",
          "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9"}
_RUN = re.compile(r"\b(?:(?:double|triple)\s+)?(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)"
                  r"(?:[\s-]+(?:(?:double|triple)\s+)?(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine|\d))+\b", re.I)


def join_spelled_digits(text: str) -> str:
    """"GR zero zero six seven" -> "GR0067"; "double zero" -> "00". Two or more
    digit words in a row only, so "one leave" stays words."""
    def run(m):
        out, times = [], 1
        for w in re.split(r"[\s-]+", m.group(0).lower()):
            if w in ("double", "triple"):
                times = 2 if w == "double" else 3
                continue
            out.append((DIGITS.get(w, w)) * times)
            times = 1
        return "".join(out)
    text = _RUN.sub(run, text)
    # A short letter prefix spoken before the digits is one code: "GR 0067" -> "GR0067".
    text = re.sub(r"\b((?:[A-Za-z]\s){1,3})(\d{2,})\b", lambda m: m.group(1).replace(" ", "").upper() + m.group(2), text)
    return re.sub(r"\b([A-Z]{1,4})\s+(\d{2,})\b", r"\1\2", text)


# ── HINDI AND ODIA: SAID IN THE SCRIPT, ANSWERED IN ENGLISH ────────────────
MT_URL = os.environ.get("GRAV_MT_URL", "http://127.0.0.1:19058")
SCRIPT = {"hi": re.compile(r"[\u0900-\u097F]"), "or": re.compile(r"[\u0B00-\u0B7F]")}


def translate(text: str, lang: str):
    """Indic -> English through the IndicTrans2 server on this pod, or None."""
    try:
        req = urllib.request.Request(f"{MT_URL}/translate", data=json.dumps({"text": text, "lang": lang}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=6) as res:
            return (json.loads(res.read()).get("english") or "").strip() or None
    except Exception:  # noqa: BLE001 — no translator: the English transcript stands
        return None


def _words(s: str) -> set:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def same_words(a: str, b: str) -> float:
    A, B = _words(a), _words(b)
    return len(A & B) / max(len(A), len(B)) if A and B else 0.0


def understand(wav: str, langs) -> dict:
    """English, Hindi or Odia — decided by what the model hears AND whether
    its Indian-script reading, translated, says the same as its English one.
    The model's own language-ID alone is unreliable (Indian-accented English
    came out labelled Hindi, written in Devanagari: "पेंडिंग लीव रिक्वेस्ट्स"),
    so a reading whose translation matches the English transcript was
    English. Anything uncertain falls back to English."""
    with LOCK:
        english = join_spelled_digits((ASR.transcribe(wav, lang="en", mode="mixed") or "").strip())
        native, lid = ASR.transcribe(wav, lang=None, mode="native", return_lid=True, allowed_langs=langs)
    native = (native or "").strip()
    lang = (lid or {}).get("lang")
    if lang not in SCRIPT or not SCRIPT[lang].search(native):
        return {"text": english, "lang": "en"}
    english_of_native = translate(native, lang)
    if english_of_native is None:
        return {"text": english, "lang": "en", "note": "no translator"}
    # Compared after the same digit-joining, so "Show Me G R Zero Zero Six
    # Seven" (an English command read as Hindi, translated back) matches the
    # English transcript "Show me GR0067".
    if same_words(english, join_spelled_digits(english_of_native)) >= 0.5:
        return {"text": english, "lang": "en"}
    return {"text": english_of_native, "lang": lang, "original": native}


def to_wav(raw: bytes) -> str:
    """Any browser recording -> 16 kHz mono WAV, at most MAX_SECONDS."""
    src = tempfile.NamedTemporaryFile(delete=False, suffix=".in")
    src.write(raw)
    src.close()
    out = src.name + ".wav"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", src.name,
         "-t", str(MAX_SECONDS), "-ac", "1", "-ar", "16000", out],
        check=True, timeout=30,
    )
    os.unlink(src.name)
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # one line per request, no audio
        sys.stdout.write("[grav-indic-stt] " + (fmt % args) + "\n")
        sys.stdout.flush()

    def _json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": "indic-transcribe-flex", "device": "cuda"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._json(400, {"error": "audio missing or too large"})
        raw = self.rfile.read(length)
        lang = (self.headers.get("X-Lang") or "en").strip()
        mode = (self.headers.get("X-Mode") or "mixed").strip()
        # "en,hi,or" → the multilingual path; a single language → as before.
        langs = [l.strip() for l in (self.headers.get("X-Langs") or "").split(",") if l.strip()]
        wav = None
        try:
            wav = to_wav(raw)
            t = time.time()
            if len(langs) > 1:
                out = understand(wav, langs)
                out["ms"] = int((time.time() - t) * 1000)
                return self._json(200, out)
            with LOCK:
                text = ASR.transcribe(wav, lang=lang, mode=mode)
            if isinstance(text, tuple):
                text = text[0]
            ms = int((time.time() - t) * 1000)
            return self._json(200, {"text": join_spelled_digits((text or "").strip()), "lang": lang, "ms": ms})
        except subprocess.CalledProcessError:
            return self._json(400, {"error": "could not decode the audio"})
        except Exception as err:  # noqa: BLE001 — never a stack to the caller
            print(f"[grav-indic-stt] error: {err!r}", flush=True)
            return self._json(500, {"error": "transcription failed"})
        finally:
            if wav and os.path.exists(wav):
                os.unlink(wav)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
