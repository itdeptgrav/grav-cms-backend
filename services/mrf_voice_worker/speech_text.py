"""Small, dependency-free speech text normalizers shared by the voice services."""

from __future__ import annotations

import re


def feminine_hindi_agent_voice(text: str) -> str:
    """Keep the female call-assistant's first-person Hindi grammar consistent."""
    replacements = (
        (r"रहा\s+हूँ", "रही हूँ"),
        (r"रहा\s+हूं", "रही हूं"),
        (r"सकता\s+हूँ", "सकती हूँ"),
        (r"सकता\s+हूं", "सकती हूं"),
        (r"चाहता\s+हूँ", "चाहती हूँ"),
        (r"चाहता\s+हूं", "चाहती हूं"),
        (r"गया\s+हूँ", "गई हूँ"),
        (r"गया\s+हूं", "गई हूं"),
        (r"समझ\s+गया", "समझ गई"),
        (r"करूँगा", "करूँगी"),
        (r"करूंगा", "करूंगी"),
    )
    for masculine, feminine in replacements:
        text = re.sub(masculine, feminine, text)
    return text


def pronounce_initialisms(text: str, language: str) -> str:
    """Give Indic TTS explicit pauses between letters in product initialisms."""
    if language == "hi":
        text = re.sub(r"एम\s*,?\s*आर\s*,?\s*एफ", "एम, आर, एफ", text)
        text = re.sub(r"सी\s*,?\s*एम\s*,?\s*एस", "सी, एम, एस", text)
        text = re.sub(r"आई\s*,?\s*टी", "आई, टी", text)
        terms = {
            "MRF": "एम, आर, एफ",
            "CMS": "सी, एम, एस",
            "GRAV": "ग्रैव",
            "IT": "आई, टी",
        }
    else:
        text = re.sub(r"ଏମ୍\s*,?\s*ଆର୍\s*,?\s*ଏଫ୍", "ଏମ୍, ଆର୍, ଏଫ୍", text)
        text = re.sub(r"ସି\s*,?\s*ଏମ୍\s*,?\s*ଏସ୍", "ସି, ଏମ୍, ଏସ୍", text)
        text = re.sub(r"ଆଇ\s*,?\s*ଟି", "ଆଇ, ଟି", text)
        terms = {
            "MRF": "ଏମ୍, ଆର୍, ଏଫ୍",
            "CMS": "ସି, ଏମ୍, ଏସ୍",
            "GRAV": "ଗ୍ରାଭ",
            "IT": "ଆଇ, ଟି",
        }
    for source in sorted(terms, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(source)}\b", terms[source], text, flags=re.I)
    return text


def spell_residual_latin(text: str, language: str) -> str:
    """Make a last-resort Indic-script pronunciation for leftover Latin tokens.

    Qwen normally transliterates whole names and office words naturally. This
    fallback is deliberately mechanical: it is only used after bounded model
    retries, and keeps one unexpected product/name token from silencing a call.
    """
    letters = {
        "hi": {
            "a": "ए", "b": "बी", "c": "सी", "d": "डी", "e": "ई", "f": "एफ",
            "g": "जी", "h": "एच", "i": "आई", "j": "जे", "k": "के", "l": "एल",
            "m": "एम", "n": "एन", "o": "ओ", "p": "पी", "q": "क्यू", "r": "आर",
            "s": "एस", "t": "टी", "u": "यू", "v": "वी", "w": "डब्ल्यू",
            "x": "एक्स", "y": "वाइ", "z": "ज़ेड",
        },
        "or": {
            "a": "ଏ", "b": "ବି", "c": "ସି", "d": "ଡି", "e": "ଇ", "f": "ଏଫ୍",
            "g": "ଜି", "h": "ଏଚ୍", "i": "ଆଇ", "j": "ଜେ", "k": "କେ", "l": "ଏଲ୍",
            "m": "ଏମ୍", "n": "ଏନ୍", "o": "ଓ", "p": "ପି", "q": "କ୍ୟୁ", "r": "ଆର୍",
            "s": "ଏସ୍", "t": "ଟି", "u": "ୟୁ", "v": "ଭି", "w": "ଡବ୍ଲ୍ୟୁ",
            "x": "ଏକ୍ସ", "y": "ୱାଇ", "z": "ଜେଡ୍",
        },
    }[language]

    def render(match: re.Match[str]) -> str:
        return ", ".join(letters[character.lower()] for character in match.group(0))

    return re.sub(r"[A-Za-z]+", render, text)


def is_hearing_acknowledgement(text: str) -> bool:
    """Recognize a caller confirming audibility without sending it to Qwen."""
    normalized = re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if is_negative_hearing_response(normalized):
        return False
    return bool(
        # Indic-Transcribe commonly renders a brief spoken "जी" as Je/Jee.
        # Treat those short phonetic variants as audibility confirmations.
        re.search(r"\b(hello|hi|yes|yeah|yep|ye|yah|haan|han|ji|jee|je|namaste)\b", normalized)
        or re.search(r"\b(sun|sunn|hear|audible)\b.*\b(raha|rahi|paa|pa|sak|can|yes)\b", normalized)
        or re.search(r"जी|हाँ|हां|सुन पा|सुन रहा|सुन रही|ଶୁଣି ପାରୁଛି|ହଁ", normalized)
    )


def is_negative_hearing_response(text: str) -> bool:
    """Detect only an explicit statement that the caller cannot hear us."""
    normalized = re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return bool(
        re.search(
            r"\b(no|not|cannot|can't|cant|nahi|nahin|nhi)\b|नहीं|नही|सुनाई नहीं|ଶୁଣି ପାରୁନି",
            normalized,
        )
    )
