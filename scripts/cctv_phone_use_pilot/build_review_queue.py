#!/usr/bin/env python3
"""Convert inference timelines into *unlabelled* phone-use review windows."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    from .annotation_schema import SCHEMA_VERSION, canonical_json, validate_dataset
except ImportError:  # Allow direct execution from the script directory.
    from annotation_schema import SCHEMA_VERSION, canonical_json, validate_dataset


PIPELINE_VERSION = "phone-use-review-queue-v1"


def _number(value: Any, default: float | None = None) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return default


def _track_id(observation: dict[str, Any]) -> int | None:
    value = observation.get("track_id", observation.get("track"))
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _state(observation: dict[str, Any]) -> str:
    fusion = observation.get("fusion")
    if isinstance(fusion, dict) and fusion.get("decision"):
        return str(fusion["decision"]).upper()
    value = observation.get("state", observation.get("emitted_label", observation.get("raw_label")))
    normalized = str(value or "UNCERTAIN").upper()
    if normalized in {"ACTIVE", "USING_PHONE"}:
        return "ACTIVE"
    if normalized in {"NOT_ACTIVE", "NO_PHONE", "NO PHONE", "NO_OBSERVABLE_TASK"}:
        return "NOT_ACTIVE"
    if normalized in {"CANDIDATE", "POSSIBLE"}:
        return "CANDIDATE"
    return "UNCERTAIN"


def load_observations(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    observations: list[dict[str, Any]] = []
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        document = None

    if isinstance(document, dict) and isinstance(document.get("timeline"), list):
        for sample in document["timeline"]:
            time_seconds = _number(sample.get("time_seconds", sample.get("time")))
            if time_seconds is None:
                continue
            for observation in sample.get("observations", []):
                if isinstance(observation, dict):
                    observations.append({**observation, "_timeSeconds": time_seconds})
        return observations

    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        # Captured worker logs contain model-load/progress messages around the
        # JSON observations. Only object-shaped lines are evidence records.
        if not line.lstrip().startswith("{"):
            continue
        try:
            observation = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_number}: invalid JSON: {exc}") from None
        if not isinstance(observation, dict):
            raise ValueError(f"line {line_number}: observation must be an object")
        time_seconds = _number(observation.get("time_seconds", observation.get("time")))
        if time_seconds is None:
            raise ValueError(f"line {line_number}: missing numeric time/time_seconds")
        observations.append({**observation, "_timeSeconds": time_seconds})
    if not observations:
        raise ValueError("input did not contain any timestamped JSON observations")
    return observations


def _candidate_evidence(observation: dict[str, Any]) -> dict[str, Any]:
    excluded = {"_timeSeconds", "box", "crop", "image", "frameData"}
    evidence: dict[str, Any] = {}
    for key, value in observation.items():
        if key in excluded:
            continue
        if value is None or isinstance(value, (str, int, float, bool)):
            evidence[key] = value
        elif isinstance(value, dict):
            evidence[key] = {
                nested_key: nested_value
                for nested_key, nested_value in value.items()
                if nested_value is None or isinstance(nested_value, (str, int, float, bool))
            }
    return evidence


def build_review_records(
    observations: Iterable[dict[str, Any]],
    *,
    clip_id: str,
    source_group: str,
    camera_ref: str,
    captured_date: str,
    source_sha256: str | None,
    split: str,
    sample_seconds: float,
    max_gap_seconds: float,
    window_seconds: float,
    candidate_only: bool,
) -> list[dict[str, Any]]:
    if sample_seconds <= 0:
        raise ValueError("sample_seconds must be positive")
    if max_gap_seconds < sample_seconds:
        raise ValueError("max_gap_seconds must be at least sample_seconds")
    if window_seconds < sample_seconds:
        raise ValueError("window_seconds must be at least sample_seconds")

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for observation in observations:
        track_id = _track_id(observation)
        time_seconds = _number(observation.get("_timeSeconds"))
        if track_id is None or time_seconds is None or time_seconds < 0:
            continue
        normalized = {**observation, "_timeSeconds": time_seconds, "_state": _state(observation)}
        if candidate_only and normalized["_state"] == "NOT_ACTIVE":
            continue
        grouped[track_id].append(normalized)

    records: list[dict[str, Any]] = []
    for track_id, track_observations in sorted(grouped.items()):
        track_observations.sort(key=lambda item: item["_timeSeconds"])
        segments: list[list[dict[str, Any]]] = []
        for observation in track_observations:
            if (
                not segments
                or observation["_timeSeconds"] - segments[-1][-1]["_timeSeconds"] > max_gap_seconds
                or observation["_state"] != segments[-1][-1]["_state"]
            ):
                segments.append([observation])
            else:
                segments[-1].append(observation)

        review_windows: list[list[dict[str, Any]]] = []
        for segment in segments:
            current: list[dict[str, Any]] = []
            window_start: float | None = None
            for observation in segment:
                if window_start is None:
                    window_start = observation["_timeSeconds"]
                if current and observation["_timeSeconds"] - window_start >= window_seconds:
                    review_windows.append(current)
                    current = []
                    window_start = observation["_timeSeconds"]
                current.append(observation)
            if current:
                review_windows.append(current)

        for window_index, review_window in enumerate(review_windows, 1):
            start = round(review_window[0]["_timeSeconds"], 3)
            end = round(review_window[-1]["_timeSeconds"] + sample_seconds, 3)
            state = review_window[-1]["_state"]
            annotation_id = f"{clip_id}-t{track_id}-{int(start * 1000):08d}-{window_index:03d}"
            records.append({
                "schemaVersion": SCHEMA_VERSION,
                "annotationId": annotation_id,
                "split": split,
                "source": {
                    "clipId": clip_id,
                    "sourceGroup": source_group,
                    "cameraRef": camera_ref,
                    "capturedDate": captured_date,
                    "sha256": source_sha256,
                },
                "target": {
                    "trackId": track_id,
                    "targetRef": f"{clip_id}:track:{track_id}",
                },
                "window": {
                    "startSeconds": start,
                    "endSeconds": end,
                },
                "reviewEvidence": {
                    "phoneVisible": "UNCERTAIN",
                    "ownedByTarget": "UNCERTAIN",
                    "handDeviceContact": "UNCERTAIN",
                    "gazeAtDevice": "UNCERTAIN",
                    "phoneAtEar": "UNCERTAIN",
                    "repetitiveManipulation": "UNCERTAIN",
                },
                "review": {
                    "status": "PENDING",
                    "label": None,
                    "reviewerId": None,
                    "reviewedAt": None,
                    "confidence": None,
                    "notes": "",
                },
                "modelSuggestion": {
                    "pipelineVersion": PIPELINE_VERSION,
                    "decision": state,
                    "sampleCount": len(review_window),
                    "firstEvidence": _candidate_evidence(review_window[0]),
                    "lastEvidence": _candidate_evidence(review_window[-1]),
                },
                "usedForTuning": False,
            })
    return records


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build an unlabelled review queue from a CCTV inference timeline"
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--clip-id", required=True)
    parser.add_argument("--source-group", required=True)
    parser.add_argument("--camera-ref", required=True)
    parser.add_argument("--captured-date", required=True, help="Source date in YYYY-MM-DD")
    parser.add_argument("--source-sha256", help="SHA-256 of the exact source clip")
    parser.add_argument(
        "--split", choices=("DEVELOPMENT", "CALIBRATION", "HOLDOUT"), default="DEVELOPMENT"
    )
    parser.add_argument("--sample-seconds", type=float, default=1.0)
    parser.add_argument("--max-gap-seconds", type=float, default=2.0)
    parser.add_argument("--window-seconds", type=float, default=4.0)
    parser.add_argument("--candidate-only", action="store_true")
    args = parser.parse_args()

    records = build_review_records(
        load_observations(args.input),
        clip_id=args.clip_id,
        source_group=args.source_group,
        camera_ref=args.camera_ref,
        captured_date=args.captured_date,
        source_sha256=args.source_sha256,
        split=args.split,
        sample_seconds=args.sample_seconds,
        max_gap_seconds=args.max_gap_seconds,
        window_seconds=args.window_seconds,
        candidate_only=args.candidate_only,
    )
    if not records:
        raise SystemExit("No review records were produced")
    validate_dataset(records)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(canonical_json(record) + "\n" for record in records), encoding="utf-8")
    print(json.dumps({"records": len(records), "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()

