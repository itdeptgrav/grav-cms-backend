#!/usr/bin/env python3
"""Render chronological full-scene and target crops for review JSONL windows.

Run this beside the vision worker's ``fast_phone_preview.py`` so the same
``assign_stable_ids`` implementation is used as the inference run.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from ultralytics import YOLO

import fast_phone_preview as fp


def letterbox(image: np.ndarray, width: int, height: int) -> np.ndarray:
    if image.size == 0:
        return np.full((height, width, 3), (24, 29, 38), dtype=np.uint8)
    source_height, source_width = image.shape[:2]
    scale = min(width / source_width, height / source_height)
    resized = cv2.resize(
        image,
        (max(1, round(source_width * scale)), max(1, round(source_height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    canvas = np.full((height, width, 3), (24, 29, 38), dtype=np.uint8)
    y = (height - resized.shape[0]) // 2
    x = (width - resized.shape[1]) // 2
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def expanded_crop(frame: np.ndarray, box: list[float], fraction: float = 0.45) -> np.ndarray:
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    dx = (x2 - x1) * fraction
    dy = (y2 - y1) * fraction
    left = max(0, int(x1 - dx))
    top = max(0, int(y1 - dy))
    right = min(width, int(x2 + dx))
    bottom = min(height, int(y2 + dy))
    return frame[top:bottom, left:right]


def sample_frames(start_seconds: float, end_seconds: float, fps: float, count: int) -> list[int]:
    if count < 2:
        raise ValueError("sample count must be at least two")
    last = max(start_seconds, end_seconds - (1.0 / fps))
    return sorted({round(value * fps) for value in np.linspace(start_seconds, last, count)})


def read_queue(path: Path, clip_id: str) -> list[dict[str, Any]]:
    records = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("source", {}).get("clipId") == clip_id:
            records.append(record)
    if not records:
        raise ValueError(f"no review records for clip {clip_id!r}")
    return records


def render(args: argparse.Namespace) -> dict[str, Any]:
    records = read_queue(args.queue, args.clip_id)
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise RuntimeError(f"could not open {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0

    requested: dict[int, list[tuple[str, int]]] = defaultdict(list)
    records_by_id = {record["annotationId"]: record for record in records}
    for record in records:
        frames = sample_frames(
            float(record["window"]["startSeconds"]),
            float(record["window"]["endSeconds"]),
            fps,
            args.samples,
        )
        for frame_index in frames:
            requested[frame_index].append((record["annotationId"], record["target"]["trackId"]))

    captures: dict[str, list[tuple[int, np.ndarray, list[float] | None, list[tuple[int, list[float]]]]]] = defaultdict(list)
    person = YOLO(args.person_model)
    tracks: dict[int, Any] = {}
    next_id = 1
    frame_index = 0
    last_requested = max(requested)

    while frame_index <= last_requested:
        ok, frame = capture.read()
        if not ok:
            break
        result = person.predict(
            frame,
            classes=[0],
            imgsz=960,
            conf=0.20,
            iou=0.50,
            device=args.device,
            verbose=False,
        )[0]
        boxes = result.boxes.xyxy.cpu().tolist() if result.boxes is not None else []
        ids, next_id = fp.assign_stable_ids(boxes, tracks, next_id, frame_index)
        people = list(zip(ids, boxes))
        for annotation_id, target_id in requested.get(frame_index, []):
            target_box = next((box for track_id, box in people if track_id == target_id), None)
            captures[annotation_id].append((frame_index, frame.copy(), target_box, people))
        frame_index += 1
    capture.release()

    args.output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for annotation_id, record in records_by_id.items():
        panels = []
        for captured_frame, frame, target_box, people in captures.get(annotation_id, []):
            scene = frame.copy()
            for track_id, box in people:
                x1, y1, x2, y2 = map(int, box)
                is_target = track_id == record["target"]["trackId"]
                color = (35, 45, 230) if is_target else (115, 115, 115)
                cv2.rectangle(scene, (x1, y1), (x2, y2), color, 3 if is_target else 1)
                cv2.putText(
                    scene,
                    f"ID {track_id}",
                    (x1, max(18, y1 - 5)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.58,
                    color,
                    2,
                    cv2.LINE_AA,
                )
            seconds = captured_frame / fps
            cv2.putText(
                scene,
                f"t={seconds:.2f}s target ID {record['target']['trackId']}",
                (18, 32),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.72,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            scene_panel = letterbox(scene, args.panel_width, args.panel_height)
            if target_box is None:
                crop_panel = np.full_like(scene_panel, (24, 29, 38))
                cv2.putText(
                    crop_panel,
                    "TARGET NOT RESOLVED",
                    (32, args.panel_height // 2),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.72,
                    (80, 170, 255),
                    2,
                    cv2.LINE_AA,
                )
            else:
                crop_panel = letterbox(
                    expanded_crop(frame, target_box), args.panel_width, args.panel_height
                )
            panels.append(np.vstack([scene_panel, crop_panel]))

        while len(panels) < args.samples:
            missing = np.full(
                (args.panel_height * 2, args.panel_width, 3),
                (24, 29, 38),
                dtype=np.uint8,
            )
            cv2.putText(
                missing,
                "FRAME UNAVAILABLE",
                (28, args.panel_height),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (80, 170, 255),
                2,
                cv2.LINE_AA,
            )
            panels.append(missing)

        sheet = np.hstack(panels[:args.samples])
        header = np.full((72, sheet.shape[1], 3), (12, 17, 27), dtype=np.uint8)
        title = (
            f"{annotation_id} | model={record.get('modelSuggestion', {}).get('decision', 'none')} "
            f"| human label required"
        )
        cv2.putText(header, title, (18, 43), cv2.FONT_HERSHEY_SIMPLEX, 0.68,
                    (255, 255, 255), 2, cv2.LINE_AA)
        sheet = np.vstack([header, sheet])
        output_path = args.output / f"{annotation_id}.jpg"
        if not cv2.imwrite(str(output_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            raise RuntimeError(f"could not write {output_path}")
        manifest.append({
            "annotationId": annotation_id,
            "path": str(output_path),
            "capturedPanels": len(captures.get(annotation_id, [])),
        })

    manifest_path = args.output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"records": len(records), "sheets": len(manifest), "manifest": str(manifest_path)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Render target-specific phone-use review sheets")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--clip-id", required=True)
    parser.add_argument("--person-model", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="0")
    parser.add_argument("--samples", type=int, default=4)
    parser.add_argument("--panel-width", type=int, default=480)
    parser.add_argument("--panel-height", type=int, default=270)
    args = parser.parse_args()
    print(json.dumps(render(args), indent=2))


if __name__ == "__main__":
    main()

