#!/usr/bin/env python3
"""Versioned human-review schema for active phone-use windows.

The schema deliberately separates model suggestions from human ground truth.
It uses mutually exclusive interaction states so that seeing a phone, holding a
phone, and actively using a phone cannot be treated as synonyms.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "phone-use-review-v1"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class InteractionLabel(str, Enum):
    NO_PHONE = "NO_PHONE"
    PHONE_VISIBLE = "PHONE_VISIBLE"
    PHONE_HELD = "PHONE_HELD"
    NOT_ACTIVE_UNSPECIFIED = "NOT_ACTIVE_UNSPECIFIED"
    ACTIVE_VIEW_OR_TYPE = "ACTIVE_VIEW_OR_TYPE"
    ACTIVE_CALL = "ACTIVE_CALL"
    ACTIVE_USE_UNSPECIFIED = "ACTIVE_USE_UNSPECIFIED"
    UNCERTAIN = "UNCERTAIN"


class Ternary(str, Enum):
    YES = "YES"
    NO = "NO"
    UNCERTAIN = "UNCERTAIN"


class ReviewStatus(str, Enum):
    PENDING = "PENDING"
    LABELLED = "LABELLED"
    ADJUDICATION_REQUIRED = "ADJUDICATION_REQUIRED"


class DatasetSplit(str, Enum):
    DEVELOPMENT = "DEVELOPMENT"
    CALIBRATION = "CALIBRATION"
    HOLDOUT = "HOLDOUT"


class Confidence(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class AnnotationValidationError(ValueError):
    """Raised when an annotation fails closed."""


@dataclass(frozen=True)
class ValidationReport:
    records: int
    labelled: int
    pending: int
    source_groups: int
    splits: dict[str, int]
    dataset_sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "records": self.records,
            "labelled": self.labelled,
            "pending": self.pending,
            "sourceGroups": self.source_groups,
            "splits": self.splits,
            "datasetSha256": self.dataset_sha256,
        }


def _required_mapping(record: dict[str, Any], key: str) -> dict[str, Any]:
    value = record.get(key)
    if not isinstance(value, dict):
        raise AnnotationValidationError(f"{key} must be an object")
    return value


def _required_text(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnnotationValidationError(f"{path} must be a non-empty string")
    return value.strip()


def _enum_value(enum_type: type[Enum], value: Any, path: str) -> str:
    try:
        return enum_type(value).value
    except (ValueError, TypeError):
        allowed = ", ".join(item.value for item in enum_type)
        raise AnnotationValidationError(f"{path} must be one of: {allowed}") from None


def _optional_ternary(evidence: dict[str, Any], key: str) -> None:
    if key in evidence:
        _enum_value(Ternary, evidence[key], f"reviewEvidence.{key}")


def validate_record(record: dict[str, Any]) -> None:
    if not isinstance(record, dict):
        raise AnnotationValidationError("record must be an object")
    if record.get("schemaVersion") != SCHEMA_VERSION:
        raise AnnotationValidationError(
            f"schemaVersion must equal {SCHEMA_VERSION!r}"
        )
    _required_text(record.get("annotationId"), "annotationId")
    split = _enum_value(DatasetSplit, record.get("split"), "split")

    source = _required_mapping(record, "source")
    _required_text(source.get("clipId"), "source.clipId")
    _required_text(source.get("sourceGroup"), "source.sourceGroup")
    _required_text(source.get("cameraRef"), "source.cameraRef")
    captured_date = _required_text(source.get("capturedDate"), "source.capturedDate")
    try:
        datetime.strptime(captured_date, "%Y-%m-%d")
    except ValueError:
        raise AnnotationValidationError("source.capturedDate must use YYYY-MM-DD") from None
    sha256 = source.get("sha256")
    if sha256 is not None and (
        not isinstance(sha256, str) or not SHA256_PATTERN.fullmatch(sha256)
    ):
        raise AnnotationValidationError("source.sha256 must be 64 lowercase hex characters")

    target = _required_mapping(record, "target")
    track_id = target.get("trackId")
    if not isinstance(track_id, int) or isinstance(track_id, bool) or track_id < 0:
        raise AnnotationValidationError("target.trackId must be a non-negative integer")
    _required_text(target.get("targetRef"), "target.targetRef")

    window = _required_mapping(record, "window")
    start = window.get("startSeconds")
    end = window.get("endSeconds")
    if not isinstance(start, (int, float)) or isinstance(start, bool) or start < 0:
        raise AnnotationValidationError("window.startSeconds must be a non-negative number")
    if not isinstance(end, (int, float)) or isinstance(end, bool) or end <= start:
        raise AnnotationValidationError("window.endSeconds must be greater than startSeconds")

    review = _required_mapping(record, "review")
    status = _enum_value(ReviewStatus, review.get("status"), "review.status")
    label = review.get("label")
    reviewer_id = review.get("reviewerId")
    reviewed_at = review.get("reviewedAt")
    confidence = review.get("confidence")

    if status == ReviewStatus.LABELLED.value:
        _enum_value(InteractionLabel, label, "review.label")
        _required_text(reviewer_id, "review.reviewerId")
        _enum_value(Confidence, confidence, "review.confidence")
        _required_text(reviewed_at, "review.reviewedAt")
        try:
            datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
        except ValueError:
            raise AnnotationValidationError("review.reviewedAt must be ISO-8601") from None
    else:
        if label is not None:
            raise AnnotationValidationError(
                "review.label must be null until review.status is LABELLED"
            )
        if any(value is not None for value in (reviewer_id, reviewed_at, confidence)):
            raise AnnotationValidationError(
                "reviewerId, reviewedAt and confidence must be null until LABELLED"
            )

    evidence = _required_mapping(record, "reviewEvidence")
    for key in (
        "phoneVisible",
        "ownedByTarget",
        "handDeviceContact",
        "gazeAtDevice",
        "phoneAtEar",
        "repetitiveManipulation",
    ):
        _optional_ternary(evidence, key)

    suggestion = record.get("modelSuggestion")
    if suggestion is not None:
        if not isinstance(suggestion, dict):
            raise AnnotationValidationError("modelSuggestion must be an object or null")
        _required_text(suggestion.get("pipelineVersion"), "modelSuggestion.pipelineVersion")
        decision = suggestion.get("decision")
        if decision is not None and decision not in {"ACTIVE", "NOT_ACTIVE", "UNCERTAIN", "CANDIDATE"}:
            raise AnnotationValidationError(
                "modelSuggestion.decision must be ACTIVE, NOT_ACTIVE, UNCERTAIN or CANDIDATE"
            )

    if split == DatasetSplit.HOLDOUT.value and record.get("usedForTuning") is True:
        raise AnnotationValidationError("HOLDOUT records cannot have usedForTuning=true")


def canonical_json(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AnnotationValidationError(f"line {line_number}: invalid JSON: {exc}") from None
        try:
            validate_record(record)
        except AnnotationValidationError as exc:
            raise AnnotationValidationError(f"line {line_number}: {exc}") from None
        records.append(record)
    if not records:
        raise AnnotationValidationError("dataset must contain at least one record")
    return records


def validate_dataset(records: Iterable[dict[str, Any]]) -> ValidationReport:
    materialized = list(records)
    annotation_ids: set[str] = set()
    group_splits: dict[str, set[str]] = {}
    exact_windows: dict[tuple[str, int, float, float], str | None] = {}
    split_counts = {split.value: 0 for split in DatasetSplit}
    labelled = 0

    for index, record in enumerate(materialized, 1):
        try:
            validate_record(record)
        except AnnotationValidationError as exc:
            raise AnnotationValidationError(f"record {index}: {exc}") from None
        annotation_id = record["annotationId"]
        if annotation_id in annotation_ids:
            raise AnnotationValidationError(f"duplicate annotationId: {annotation_id}")
        annotation_ids.add(annotation_id)

        source_group = record["source"]["sourceGroup"]
        split = record["split"]
        group_splits.setdefault(source_group, set()).add(split)
        split_counts[split] += 1

        if record["review"]["status"] == ReviewStatus.LABELLED.value:
            labelled += 1
        key = (
            record["source"]["clipId"],
            record["target"]["trackId"],
            float(record["window"]["startSeconds"]),
            float(record["window"]["endSeconds"]),
        )
        label = record["review"]["label"]
        if key in exact_windows and exact_windows[key] != label:
            raise AnnotationValidationError(
                "conflicting labels for exact clip/track/window: " + repr(key)
            )
        exact_windows[key] = label

    leaking = {
        group: sorted(splits)
        for group, splits in group_splits.items()
        if len(splits) > 1
    }
    if leaking:
        details = "; ".join(f"{group}={splits}" for group, splits in sorted(leaking.items()))
        raise AnnotationValidationError(f"source-group split leakage: {details}")

    digest = hashlib.sha256()
    for record in sorted(materialized, key=lambda item: item["annotationId"]):
        digest.update(canonical_json(record).encode("utf-8"))
        digest.update(b"\n")
    return ValidationReport(
        records=len(materialized),
        labelled=labelled,
        pending=len(materialized) - labelled,
        source_groups=len(group_splits),
        splits=split_counts,
        dataset_sha256=digest.hexdigest(),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a CCTV phone-use review JSONL file")
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    try:
        report = validate_dataset(read_jsonl(args.dataset))
    except AnnotationValidationError as exc:
        raise SystemExit(f"INVALID: {exc}") from None
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

