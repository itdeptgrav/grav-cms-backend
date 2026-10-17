"""Measure first-audio and total latency for an Indic Parler streaming utterance."""

from __future__ import annotations

import json
import threading
import time

import torch
from parler_tts import ParlerTTSForConditionalGeneration, ParlerTTSStreamer
from transformers import AutoTokenizer


MODEL_PATH = "/workspace/models/indic-parler-tts"
TEXT = (
    "हेलो। अनिता दास ने एक मटेरियल रिक्वेस्ट आपके अप्रूवल के लिए भेजी है। "
    "क्या आप इसकी डिटेल्स सुनना चाहेंगे?"
)
DESCRIPTION = (
    "Divya speaks in a warm, natural, conversational Hindi office tone at a moderate "
    "pace with balanced pitch. The recording is close, clear, expressive, and free of "
    "background noise. She sounds helpful and confident, not theatrical."
)


def main() -> None:
    load_started = time.perf_counter()
    model = ParlerTTSForConditionalGeneration.from_pretrained(
        MODEL_PATH,
        torch_dtype=torch.float16,
        local_files_only=True,
    ).to("cuda")
    prompt_tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
    description_tokenizer = AutoTokenizer.from_pretrained(
        model.config.text_encoder._name_or_path
    )
    load_seconds = time.perf_counter() - load_started

    description = description_tokenizer(DESCRIPTION, return_tensors="pt").to("cuda")
    prompt = prompt_tokenizer(TEXT, return_tensors="pt").to("cuda")
    streamer = ParlerTTSStreamer(model, play_steps=10)
    kwargs = {
        "input_ids": description.input_ids,
        "attention_mask": description.attention_mask,
        "prompt_input_ids": prompt.input_ids,
        "prompt_attention_mask": prompt.attention_mask,
        "streamer": streamer,
    }

    started = time.perf_counter()
    thread = threading.Thread(target=model.generate, kwargs=kwargs, daemon=True)
    thread.start()
    chunk_count = 0
    sample_count = 0
    first_audio_seconds = None
    for audio in streamer:
        if first_audio_seconds is None and len(audio):
            first_audio_seconds = time.perf_counter() - started
        chunk_count += 1
        sample_count += len(audio)
    thread.join()
    total_seconds = time.perf_counter() - started
    print(
        json.dumps(
            {
                "load_seconds": round(load_seconds, 3),
                "first_audio_seconds": round(first_audio_seconds or 0, 3),
                "total_generation_seconds": round(total_seconds, 3),
                "audio_seconds": round(sample_count / model.config.sampling_rate, 3),
                "chunks": chunk_count,
            }
        )
    )


if __name__ == "__main__":
    main()
