#!/usr/bin/env python3
"""Score Qwen binary interaction prompts on pre-extracted two-moment pair panels."""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import cv2
import torch
from PIL import Image
from qwen_vl_utils import process_vision_info
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration


PROMPTS = {
    "strict_reciprocal": """Determine whether TARGET and PERSON B are visibly interacting across these two moments.

INTERACTING requires clear reciprocal evidence such as both people facing, responding,
gesturing, or attending to one another.

Standing nearby, looking once, watching, waiting, walking past, or a one-sided gesture
is NOT sufficient.

Return exactly one digit:
1 = INTERACTING
2 = NO CLEAR INTERACTION
Answer:""",
    "directed_exchange": """Judge whether TARGET and PERSON B are visibly engaged with each other across the EARLIER and CURRENT moments.

Choose INTERACTING when one person directs a gesture, object, expression, or attention toward the other and the other person visibly attends or responds. They do not need to gesture at the same time.

Choose NO CLEAR INTERACTION when they are only nearby, pass each other, watch without response, or remain focused on a laptop, phone, desk, or another person.

Return exactly one digit:
1 = INTERACTING
2 = NO CLEAR INTERACTION
Answer:""",
}


def generate(model, processor, images, prompt):
    content = [{"type": "image", "image": image} for image in images]
    content.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, _ = process_vision_info(messages)
    inputs = processor(
        text=[text], images=image_inputs, videos=None, padding=True, return_tensors="pt"
    ).to("cuda")
    started = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=4, do_sample=False, use_cache=True)
    elapsed = time.perf_counter() - started
    decoded = processor.batch_decode(
        generated[:, inputs.input_ids.shape[1]:], skip_special_tokens=True
    )[0].strip()
    match = re.search(r"[12]", decoded)
    return (match.group(0) if match else ""), decoded, elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-set", required=True)
    parser.add_argument("--image-directory", required=True)
    parser.add_argument("--qwen-model", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    audit = json.loads(Path(args.audit_set).read_text(encoding="utf-8"))
    image_directory = Path(args.image_directory)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        args.qwen_model,
        torch_dtype=torch.bfloat16,
        device_map="cuda",
        attn_implementation="sdpa",
    ).eval()
    processor = AutoProcessor.from_pretrained(
        args.qwen_model, min_pixels=128 * 28 * 28, max_pixels=384 * 28 * 28
    )

    report = {"sample_count": len(audit["samples"]), "prompts": {}}
    for prompt_name, prompt in PROMPTS.items():
        results = []
        for sample in audit["samples"]:
            panel = cv2.imread(str(image_directory / sample["image"]))
            if panel is None:
                raise FileNotFoundError(sample["image"])
            split = panel.shape[0] // 2
            images = [
                Image.fromarray(cv2.cvtColor(panel[:split], cv2.COLOR_BGR2RGB)),
                Image.fromarray(cv2.cvtColor(panel[split:], cv2.COLOR_BGR2RGB)),
            ]
            digit, raw, seconds = generate(model, processor, images, prompt)
            predicted = "interacting" if digit == "1" else "no_clear_interaction"
            item = {
                **sample,
                "predicted": predicted,
                "correct": predicted == sample["expected"],
                "raw": raw,
                "seconds": round(seconds, 3),
            }
            results.append(item)
            print(json.dumps({"prompt": prompt_name, **item}), flush=True)

        positive = [item for item in results if item["expected"] == "interacting"]
        negative = [item for item in results if item["expected"] == "no_clear_interaction"]
        predicted_positive = [item for item in results if item["predicted"] == "interacting"]
        true_positive = sum(item["correct"] for item in positive)
        true_negative = sum(item["correct"] for item in negative)
        correct = true_positive + true_negative
        report["prompts"][prompt_name] = {
            "correct": correct,
            "accuracy": round(correct / len(results), 4),
            "interaction_recall": round(true_positive / len(positive), 4),
            "interaction_precision": round(
                true_positive / len(predicted_positive), 4
            ) if predicted_positive else 0.0,
            "no_interaction_specificity": round(true_negative / len(negative), 4),
            "mean_seconds": round(sum(item["seconds"] for item in results) / len(results), 3),
            "results": results,
        }

    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        name: {key: value for key, value in data.items() if key != "results"}
        for name, data in report["prompts"].items()
    }, indent=2))


if __name__ == "__main__":
    main()
