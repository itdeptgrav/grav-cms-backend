"""Generate Hindi and Odia voice samples for the Indic Parler evaluation."""

from __future__ import annotations

import json
import time
from pathlib import Path

import soundfile as sf
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer


MODEL_PATH = "/workspace/models/indic-parler-tts"
OUTPUT_DIR = Path("/workspace/grav-mrf-voice/samples/indic-parler")

SAMPLES = {
    "hindi-divya": {
        "text": (
            "हेलो। अनिता दास ने एक मटेरियल रिक्वेस्ट आपके अप्रूवल के लिए भेजी है। "
            "क्या आप इसकी डिटेल्स सुनना चाहेंगे?"
        ),
        "description": (
            "Divya speaks in a warm, natural, conversational Hindi office tone at a "
            "moderate pace with balanced pitch. The recording is close, clear, expressive, "
            "and free of background noise. She sounds helpful and confident, not theatrical."
        ),
    },
    "odia-debjani": {
        "text": (
            "ହେଲୋ। ଅନିତା ଦାସ ଗୋଟିଏ ମ୍ୟାଟେରିଆଲ୍ ରିକ୍ୱେଷ୍ଟ ଆପଣଙ୍କ ଆପ୍ରୁଭାଲ୍ ପାଇଁ "
            "ପଠାଇଛନ୍ତି। ଆପଣ ଏହାର ଡିଟେଲ୍ସ ଶୁଣିବାକୁ ଚାହୁଁଛନ୍ତି କି?"
        ),
        "description": (
            "Debjani speaks in a warm, natural, conversational Odia office tone at a "
            "moderate pace with balanced pitch. The recording is close, clear, expressive, "
            "and free of background noise. She sounds helpful and confident, not theatrical."
        ),
    },
}


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    model = ParlerTTSForConditionalGeneration.from_pretrained(
        MODEL_PATH,
        torch_dtype=torch.float16,
        local_files_only=True,
    ).to("cuda")
    prompt_tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
    description_tokenizer = AutoTokenizer.from_pretrained(
        model.config.text_encoder._name_or_path
    )
    load_seconds = time.perf_counter() - started

    results = []
    for name, sample in SAMPLES.items():
        description = description_tokenizer(
            sample["description"], return_tensors="pt"
        ).to("cuda")
        prompt = prompt_tokenizer(sample["text"], return_tensors="pt").to("cuda")
        torch.cuda.synchronize()
        generation_started = time.perf_counter()
        with torch.inference_mode():
            waveform = model.generate(
                input_ids=description.input_ids,
                attention_mask=description.attention_mask,
                prompt_input_ids=prompt.input_ids,
                prompt_attention_mask=prompt.attention_mask,
            )
        torch.cuda.synchronize()
        generation_seconds = time.perf_counter() - generation_started
        output_path = OUTPUT_DIR / f"{name}.wav"
        audio = waveform.detach().float().cpu().numpy().squeeze()
        sf.write(output_path, audio, model.config.sampling_rate)
        results.append(
            {
                "name": name,
                "path": str(output_path),
                "generation_seconds": round(generation_seconds, 3),
                "audio_seconds": round(len(audio) / model.config.sampling_rate, 3),
            }
        )

    print(json.dumps({"load_seconds": round(load_seconds, 3), "samples": results}))


if __name__ == "__main__":
    main()
