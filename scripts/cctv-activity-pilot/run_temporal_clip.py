#!/usr/bin/env python3
"""Offline full-clip runner for four-second Qwen activity windows."""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter, defaultdict, deque
from pathlib import Path

import cv2
import torch
from PIL import Image
from qwen_vl_utils import process_vision_info
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
from ultralytics import YOLO

from qwen_temporal_prompt import PROMPT, PROMPT_VERSION, build_contact_sheet
from temporal_policy import TemporalPolicy


DIGIT_LABELS = {
    "1": "using_phone",
    "2": "working",
    "3": "talking_or_interacting",
    "4": "no_observable_task",
    "5": "uncertain",
}


def expanded_crop(frame, box, fraction=0.18):
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = [float(value) for value in box]
    dx, dy = (x2 - x1) * fraction, (y2 - y1) * fraction
    x1, y1 = max(0, int(x1 - dx)), max(0, int(y1 - dy))
    x2, y2 = min(width, int(x2 + dx)), min(height, int(y2 + dy))
    return frame[y1:y2, x1:x2]


def classify_window(model, processor, images):
    contact_sheet = build_contact_sheet(images)
    messages = [{"role": "user", "content": [
        {"type": "image", "image": contact_sheet},
        {"type": "text", "text": PROMPT},
    ]}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, _ = process_vision_info(messages)
    inputs = processor(
        text=[text], images=image_inputs, videos=None, padding=True, return_tensors="pt"
    ).to("cuda")
    started = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=4, do_sample=False, use_cache=True)
    torch.cuda.synchronize()
    elapsed_ms = (time.perf_counter() - started) * 1000
    answer = processor.batch_decode(
        generated[:, inputs.input_ids.shape[1]:], skip_special_tokens=True
    )[0].strip()
    match = re.search(r"[1-5]", answer)
    label = DIGIT_LABELS[match.group(0)] if match else "uncertain"
    return label, answer, round(elapsed_ms, 2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--person-model", required=True)
    parser.add_argument("--qwen-model", required=True)
    parser.add_argument("--sample-seconds", type=float, default=1.0)
    parser.add_argument("--window-frames", type=int, default=4)
    parser.add_argument("--confirmations", type=int, default=2)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.window_frames != 4:
        raise SystemExit("Version 2 contract requires exactly four window frames")

    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        raise SystemExit(f"Could not open {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    declared_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    sample_every = max(1, round(fps * args.sample_seconds))

    person_model = YOLO(args.person_model)
    qwen = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        args.qwen_model,
        torch_dtype=torch.bfloat16,
        device_map="cuda",
        attn_implementation="sdpa",
    ).eval()
    processor = AutoProcessor.from_pretrained(
        args.qwen_model,
        min_pixels=128 * 28 * 28,
        max_pixels=384 * 28 * 28,
    )

    histories = defaultdict(lambda: deque(maxlen=args.window_frames))
    policy = TemporalPolicy(confirmations=args.confirmations, uncertain_hold=2)
    timeline = []
    frame_index = 0
    started = time.perf_counter()

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        result = person_model.track(
            frame,
            persist=True,
            tracker="bytetrack.yaml",
            classes=[0],
            imgsz=640,
            conf=0.30,
            iou=0.50,
            device=0,
            verbose=False,
        )[0]
        boxes = result.boxes.xyxy.cpu().tolist() if result.boxes is not None else []
        if result.boxes is not None and result.boxes.id is not None:
            ids = [int(value) for value in result.boxes.id.cpu().tolist()]
        else:
            ids = list(range(len(boxes)))

        if frame_index % sample_every == 0:
            active_ids = set(ids)
            for missing_id in list(histories):
                if missing_id not in active_ids:
                    del histories[missing_id]
            policy.remove_missing_tracks(active_ids)

            observations = []
            for track_id, box in zip(ids, boxes):
                crop = expanded_crop(frame, box)
                if not crop.size:
                    continue
                histories[track_id].append(
                    Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                )
                window_complete = len(histories[track_id]) == args.window_frames
                if window_complete:
                    raw_label, raw_answer, latency_ms = classify_window(
                        qwen, processor, list(histories[track_id])
                    )
                else:
                    raw_label, raw_answer, latency_ms = "uncertain", "warming_up", 0.0
                smoothed = policy.observe(
                    track_id, raw_label, window_complete=window_complete
                )
                observations.append({
                    **smoothed.to_dict(),
                    "raw_answer": raw_answer,
                    "inference_latency_ms": latency_ms,
                    "window_samples": len(histories[track_id]),
                    "box": [round(value, 1) for value in box],
                })

            timeline.append({
                "sample": len(timeline) + 1,
                "time_seconds": round(frame_index / fps, 2),
                "frame": frame_index,
                "people": len(boxes),
                "observations": observations,
            })
            print(
                f"sample={len(timeline)} time={frame_index / fps:.1f}s people={len(boxes)}",
                flush=True,
            )
        frame_index += 1

    capture.release()
    elapsed = time.perf_counter() - started
    raw_counts = Counter()
    emitted_counts = Counter()
    latencies = []
    for sample in timeline:
        for observation in sample["observations"]:
            raw_counts[observation["raw_label"]] += 1
            emitted_counts[observation["emitted_label"]] += 1
            if observation["inference_latency_ms"]:
                latencies.append(observation["inference_latency_ms"])

    report = {
        "source": args.video,
        "contract": {
            "prompt_version": PROMPT_VERSION,
            "window_frames": args.window_frames,
            "sample_seconds": args.sample_seconds,
            "confirmations": args.confirmations,
            "first_decision_delay_seconds": args.sample_seconds * (args.window_frames - 1),
        },
        "video": {
            "fps": round(fps, 3),
            "declared_frames": declared_frames,
            "processed_frames": frame_index,
            "duration_seconds": round(frame_index / fps, 2),
        },
        "performance": {
            "wall_seconds_excluding_model_load": round(elapsed, 2),
            "effective_fps": round(frame_index / elapsed, 2),
            "mean_window_inference_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
            "max_window_inference_ms": round(max(latencies), 2) if latencies else None,
        },
        "raw_window_counts": dict(raw_counts),
        "emitted_counts": dict(emitted_counts),
        "timeline": timeline,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "timeline"}, indent=2))


if __name__ == "__main__":
    main()
