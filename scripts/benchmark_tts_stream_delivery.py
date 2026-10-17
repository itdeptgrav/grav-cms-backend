"""Measure whether streamed TTS produces PCM quickly enough for gapless playout."""

from __future__ import annotations

import base64
import json
import os
import time

import httpx


URL = os.environ.get("GRAV_TTS_BENCHMARK_URL", "http://127.0.0.1:8890/v1/audio/speech")
KEY = os.environ["GRAV_SPEECH_GATEWAY_KEY"]
MODEL = os.environ.get("GRAV_TTS_BENCHMARK_MODEL", "parler-hi")
TEXT = os.environ.get(
    "GRAV_TTS_BENCHMARK_TEXT",
    "हेलो। अनिता दास ने एक मटेरियल रिक्वेस्ट आपके अप्रूवल के लिए भेजी है। क्या आप इसकी डिटेल्स सुनना चाहेंगे?",
)


def main() -> None:
    started = time.perf_counter()
    previous = started
    audio_seconds = 0.0
    chunks: list[dict] = []
    with httpx.stream(
        "POST",
        URL,
        headers={"Authorization": f"Bearer {KEY}"},
        json={"model": MODEL, "input": TEXT, "response_format": "wav"},
        timeout=180,
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            event = json.loads(line[6:])
            encoded = event.get("delta")
            if not encoded:
                continue
            now = time.perf_counter()
            pcm = base64.b64decode(encoded)
            duration = len(pcm) / (24000 * 2)
            chunks.append(
                {
                    "arrival": round(now - started, 3),
                    "gap": round(now - previous, 3),
                    "audio": round(duration, 3),
                }
            )
            audio_seconds += duration
            previous = now
    wall_seconds = time.perf_counter() - started
    print(
        json.dumps(
            {
                "model": MODEL,
                "first_audio": chunks[0]["arrival"] if chunks else None,
                "wall_seconds": round(wall_seconds, 3),
                "audio_seconds": round(audio_seconds, 3),
                "realtime_factor": round(wall_seconds / audio_seconds, 3) if audio_seconds else None,
                "max_delivery_gap": max((chunk["gap"] for chunk in chunks[1:]), default=0),
                "chunks": chunks[:12],
            }
        )
    )


if __name__ == "__main__":
    main()
