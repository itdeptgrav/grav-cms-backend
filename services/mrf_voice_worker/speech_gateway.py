"""Pod-private OpenAI adapter around the existing GRAV Speech service and TTS."""

from __future__ import annotations

import io
import hashlib
import os
import re
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from kokoro import KPipeline
from pydantic import BaseModel
from speech_text import feminine_hindi_agent_voice, pronounce_initialisms, spell_residual_latin


KEY = os.environ.get("GRAV_SPEECH_GATEWAY_KEY", "local-only")
DEVICE = os.environ.get("GRAV_TTS_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
GRAV_SPEECH_APP_ROOT = Path(os.environ.get("GRAV_SPEECH_APP_ROOT", "/workspace/grav-speech/app"))
GRAV_SPEECH_MODEL_DIR = Path(os.environ.get("GRAV_SPEECH_MODEL_DIR", "/workspace/grav-speech/models/indic-transcribe-flex"))
GRAV_SPEECH_DIARIZER_PATH = Path(os.environ.get("GRAV_SPEECH_DIARIZER_PATH", "/workspace/grav-speech/models/diar_sortformer_4spk-v1.nemo"))
PARLER_MODEL_PATH = Path(os.environ.get("GRAV_PARLER_MODEL_PATH", "/workspace/models/indic-parler-tts"))
INDIC_GATEWAY_URL = os.environ.get("GRAV_INDIC_GATEWAY_URL", "http://127.0.0.1:8892")
HINDI_GATEWAY_URL = os.environ.get("GRAV_HINDI_GATEWAY_URL", "http://127.0.0.1:8894")
TRANSLATION_GATEWAY_URL = os.environ.get("GRAV_TRANSLATION_GATEWAY_URL", "http://127.0.0.1:8893/v1").rstrip("/")
TRANSLATION_KEY = os.environ.get("GRAV_TRANSLATION_GATEWAY_KEY", KEY)

app = FastAPI(title="GRAV MRF Speech Gateway", docs_url=None, redoc_url=None)
# STT, local English TTS and caches must not share one lock. Indic synthesis
# can take many seconds; coupling it to STT made the agent appear deaf while
# background audio was being prepared.
stt_lock = threading.Lock()
kokoro_lock = threading.Lock()
cache_lock = threading.Lock()
grav_speech = None
kokoro_pipelines: dict[str, KPipeline] = {}
localized_cache: dict[tuple[str, str], str] = {}
speech_cache: dict[tuple[str, str, str, float], bytes] = {}
SPEECH_CACHE_DIR = Path(os.environ.get(
    "GRAV_SPEECH_CACHE_DIR",
    "/workspace/grav-mrf-voice/cache/tts",
))


def speech_cache_path(key: tuple[str, str, str, float]) -> Path:
    digest = hashlib.sha256(repr(key).encode("utf-8")).hexdigest()
    return SPEECH_CACHE_DIR / f"{digest}.wav"


def cached_speech(key: tuple[str, str, str, float]) -> bytes | None:
    with cache_lock:
        cached = speech_cache.get(key)
    if cached is not None:
        return cached
    path = speech_cache_path(key)
    try:
        cached = path.read_bytes()
    except OSError:
        return None
    with cache_lock:
        if len(speech_cache) >= 64:
            speech_cache.pop(next(iter(speech_cache)))
        speech_cache[key] = cached
    return cached


def remember_speech(key: tuple[str, str, str, float], audio: bytes) -> None:
    with cache_lock:
        if len(speech_cache) >= 64:
            speech_cache.pop(next(iter(speech_cache)))
        speech_cache[key] = audio
    try:
        SPEECH_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=SPEECH_CACHE_DIR, suffix=".tmp", delete=False) as temporary:
            temporary.write(audio)
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, speech_cache_path(key))
    except OSError:
        # Memory caching remains authoritative if the persistent volume is
        # temporarily unavailable.
        try:
            temporary_path.unlink(missing_ok=True)
        except (OSError, UnboundLocalError):
            pass


def native_product_terms(text: str, language: str) -> str:
    text = pronounce_initialisms(text, language)
    terms = {
        "hi": {
            "Industrial sewing needles": "इंडस्ट्रियल सिलाई नीडल्स",
            "sewing needles": "सिलाई नीडल्स",
            "packing tape": "पैकिंग टेप",
            "machine oil": "मशीन ऑयल",
            "boxes": "बॉक्स",
            "rolls": "रोल",
            "cans": "कैन",
            "Voice Lab": "वॉइस लैब",
            "Requests": "रिक्वेस्ट्स",
            "Home": "होम",
        },
        "or": {
            "Voice Lab": "ଭଏସ୍ ଲ୍ୟାବ୍",
            "Requests": "ରିକ୍ୱେଷ୍ଟସ୍",
            "Home": "ହୋମ୍",
        },
    }[language]
    for source in sorted(terms, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(source)}\b", terms[source], text, flags=re.I)
    return text


def colloquial_office_terms(text: str, language: str) -> str:
    """Prefer the office vocabulary people actually use in Hindi and Odia."""
    replacements = {
        "hi": (
            ("सामग्री अनुरोध", "मटेरियल रिक्वेस्ट"),
            ("अनुमोदन", "अप्रूवल"),
            ("मंजूरी", "अप्रूवल"),
            ("मंजूर", "अप्रूव"),
            ("अस्वीकृति", "रिजेक्शन"),
            ("अस्वीकार", "रिजेक्ट"),
            ("पुष्टि", "कन्फर्म"),
            ("लंबित", "पेंडिंग"),
            ("निर्णय", "डिसीजन"),
            ("वस्तुएँ", "आइटम्स"),
            ("अनुरोध", "रिक्वेस्ट"),
        ),
        "or": (
            ("ସାମଗ୍ରୀ ଅନୁରୋଧ", "ମ୍ୟାଟେରିଆଲ୍ ରିକ୍ୱେଷ୍ଟ"),
            ("ଅନୁମୋଦନ", "ଆପ୍ରୁଭାଲ୍"),
            ("ପ୍ରତ୍ୟାଖ୍ୟାନ", "ରିଜେକ୍ଟ"),
            ("ନିଶ୍ଚିତ", "କନ୍ଫର୍ମ"),
            ("ନିଷ୍ପତ୍ତି", "ଡିସିସନ୍"),
            ("ବସ୍ତୁ", "ଆଇଟମ୍"),
            ("ଅନୁରୋଧ", "ରିକ୍ୱେଷ୍ଟ"),
        ),
    }[language]
    for formal, spoken in replacements:
        text = text.replace(formal, spoken)
    return text

def authenticate(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {KEY}":
        raise HTTPException(status_code=401, detail="Unauthenticated")


def grav_speech_engine():
    global grav_speech
    if grav_speech is None:
        sys.path.insert(0, str(GRAV_SPEECH_APP_ROOT))
        from services.grav_speech_api.inference import SpeechEngine
        grav_speech = SpeechEngine(GRAV_SPEECH_MODEL_DIR, GRAV_SPEECH_DIARIZER_PATH)
        grav_speech.preload()
    return grav_speech


def kokoro_pipeline(language: str = "en") -> KPipeline:
    pipeline = kokoro_pipelines.get(language)
    if pipeline is None:
        pipeline = KPipeline(lang_code="h" if language == "hi" else "a")
        kokoro_pipelines[language] = pipeline
    return pipeline


@app.on_event("startup")
def prewarm_required_models() -> None:
    """Do not advertise the speech adapter until English STT/TTS are usable."""
    with stt_lock:
        grav_speech_engine()
    with kokoro_lock:
        kokoro_pipeline("en")


def wav_response(audio, sample_rate: int = 24000) -> Response:
    values = np.asarray(audio, dtype=np.float32)
    stream = io.BytesIO()
    sf.write(stream, values, sample_rate, format="WAV", subtype="PCM_16")
    return Response(stream.getvalue(), media_type="audio/wav")


def localized_indic_text(text: str, language: str) -> str:
    """Never send English/romanized CMS prose to an Indic voice."""
    text = colloquial_office_terms(native_product_terms(text, language), language)
    if language == "hi":
        text = feminine_hindi_agent_voice(text)
    latin = re.search(r"[A-Za-z]", text)
    if not latin:
        return text
    key = (language, text)
    with cache_lock:
        if key in localized_cache:
            return localized_cache[key]

    def translate_fragment(fragment: str) -> str:
        result = httpx.post(
            f"{TRANSLATION_GATEWAY_URL}/translate",
            headers={"Authorization": f"Bearer {TRANSLATION_KEY}"},
            json={"text": fragment, "language": language},
            timeout=45,
        )
        result.raise_for_status()
        return str(result.json().get("text") or "").strip()

    try:
        expected = re.compile(r"[\u0900-\u097f]" if language == "hi" else r"[\u0b00-\u0b7f]")
        latin_count = len(re.findall(r"[A-Za-z]", text))
        native_count = len(expected.findall(text))
        if latin_count > native_count:
            # An otherwise-English catalogue description is handled as one
            # phrase so quantities and units stay paired. Common daily-office
            # terms were already converted phonetically above.
            localized = translate_fragment(text)
        else:
            # Translating an otherwise-Hindi sentence as English can corrupt
            # the fixed approval wording (for example "material request").
            # Translate only embedded names/catalogue phrases and preserve the
            # controller-owned native-script sentence around them.
            localized = re.sub(
                r"[A-Za-z]+(?:[\t '-]+[A-Za-z]+)*",
                lambda match: translate_fragment(match.group(0)),
                text,
            )
        localized = colloquial_office_terms(
            native_product_terms(localized, language),
            language,
        )
        if language == "hi":
            localized = feminine_hindi_agent_voice(localized)
    except (httpx.HTTPError, OSError, ValueError) as error:
        raise HTTPException(
            status_code=503,
            detail=f"Native {language} speech text could not be prepared.",
        ) from error
    if not localized or not expected.search(localized):
        raise HTTPException(status_code=503, detail=f"Native {language} speech text is invalid.")
    # A bounded Qwen retry normally removes every Latin token. If a rare name
    # or catalogue term still survives, pronounce its letters in the target
    # script rather than returning 503 and leaving the caller in silence.
    if re.search(r"[A-Za-z]", localized):
        localized = spell_residual_latin(localized, language)
    with cache_lock:
        if len(localized_cache) >= 256:
            localized_cache.pop(next(iter(localized_cache)))
        localized_cache[key] = localized
    return localized


class SpeechTextRequest(BaseModel):
    input: str
    language: str


@app.post("/v1/speech-text", dependencies=[Depends(authenticate)])
def speech_text(body: SpeechTextRequest) -> dict:
    if body.language not in {"hi", "or"}:
        return {"text": body.input.strip(), "language": body.language}
    return {
        "text": localized_indic_text(body.input.strip(), body.language),
        "language": body.language,
    }


@app.get("/health")
def health() -> dict:
    stt_ready = GRAV_SPEECH_MODEL_DIR.is_dir()
    indic_ready = PARLER_MODEL_PATH.is_dir()
    try:
        hindi_response = httpx.get(f"{HINDI_GATEWAY_URL}/health", timeout=1.0)
        hindi_ready = bool(
            hindi_response.is_success
            and hindi_response.json().get("loaded") is True
        )
    except (httpx.HTTPError, OSError, ValueError):
        hindi_ready = False
    return {
        "status": "ready" if stt_ready and indic_ready else "degraded",
        "device": DEVICE,
        "stt": "bodhan-ai/indic-transcribe-flex via GRAV Speech" if stt_ready else "model-missing",
        "sttLoaded": grav_speech is not None,
        "englishTts": "kokoro-82m",
        "englishTtsLoaded": "en" in kokoro_pipelines,
        "hindiTts": "ResembleAI/Chatterbox-Multilingual-hi",
        "hindiTtsLoaded": hindi_ready,
        "indicTts": "ai4bharat/indic-parler-tts" if indic_ready else "access-required",
    }


@app.post("/v1/audio/transcriptions", dependencies=[Depends(authenticate)])
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-1"),
    language: str | None = Form(default=None),
) -> dict:
    del model
    suffix = Path(file.filename or "speech.wav").suffix or ".wav"
    payload = await file.read()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
        temporary.write(payload)
        path = Path(temporary.name)
    try:
        with stt_lock:
            result = grav_speech_engine().transcribe_utterance(path)
        return {"text": result.get("romanTranscript", ""), "language": language or "multi"}
    finally:
        path.unlink(missing_ok=True)


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: str = "af_heart"
    response_format: str = "wav"
    speed: float = 1.0


@app.post("/v1/audio/speech", dependencies=[Depends(authenticate)])
def speech(body: SpeechRequest) -> Response:
    if body.response_format != "wav":
        raise HTTPException(status_code=400, detail="Only wav output is supported")
    text = body.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Speech text is required")
    if body.model in {"kokoro-hi", "chatterbox-hi"}:
        text = localized_indic_text(text, "hi")
    # The product wordmark is uppercase in CMS copy, but it is a spoken name,
    # not an initialism. Kokoro otherwise tends to say G-R-A-V letter by letter.
    text = re.sub(r"\bGRAV\b", "Grav", text, flags=re.I)
    voice = "hf_alpha" if body.model == "kokoro-hi" else body.voice
    cache_key = (body.model, text, voice, round(body.speed, 2))
    cached = cached_speech(cache_key)
    if cached is not None:
        return Response(cached, media_type="audio/wav")
    if body.model in {"kokoro", "kokoro-hi"}:
        language = "hi" if body.model == "kokoro-hi" else "en"
        with kokoro_lock:
            # A concurrent prewarm may have completed while this request waited.
            cached = cached_speech(cache_key)
            if cached is not None:
                return Response(cached, media_type="audio/wav")
            chunks = [
                audio
                for _graphemes, _phonemes, audio in kokoro_pipeline(language)(
                    text, voice=voice, speed=body.speed
                )
            ]
            response = wav_response(np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32))
        remember_speech(cache_key, bytes(response.body))
        return response
    if body.model == "chatterbox-hi":
        try:
            result = httpx.post(
                f"{HINDI_GATEWAY_URL}/v1/audio/speech",
                headers={"Authorization": f"Bearer {KEY}"},
                json=body.model_copy(update={"input": text}).model_dump(),
                timeout=180,
            )
            result.raise_for_status()
        except (httpx.HTTPError, OSError) as error:
            raise HTTPException(
                status_code=503,
                detail="Hindi Chatterbox synthesis service is unavailable",
            ) from error
        remember_speech(cache_key, result.content)
        return Response(result.content, media_type="audio/wav")
    if body.model not in {"parler-hi", "parler-or", "indicf5-hi", "indicf5-or"}:
        raise HTTPException(status_code=400, detail="Unsupported speech model")
    language_code = "hi" if body.model.endswith("-hi") else "or"
    payload = body.model_dump()
    payload["model"] = f"parler-{language_code}"
    payload["input"] = localized_indic_text(text, language_code)

    def proxy_stream():
        try:
            with httpx.stream(
                "POST",
                f"{INDIC_GATEWAY_URL}/v1/audio/speech",
                headers={"Authorization": f"Bearer {KEY}"},
                json=payload,
                timeout=180,
            ) as result:
                result.raise_for_status()
                yield from result.iter_raw()
        except (httpx.HTTPError, OSError) as error:
            raise RuntimeError("Indic Parler synthesis service is unavailable") from error

    # Preserve the upstream SSE framing. LiveKit begins playout as soon as the
    # first PCM delta arrives instead of waiting for the whole sentence.
    return StreamingResponse(proxy_stream(), media_type="text/event-stream")
