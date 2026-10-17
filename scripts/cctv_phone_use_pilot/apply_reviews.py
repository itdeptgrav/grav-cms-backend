#!/usr/bin/env python3
"""Apply attributable review decisions to a generated phone-use queue."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from scripts.cctv_phone_use_pilot.annotation_schema import (
    AnnotationValidationError,
    Confidence,
    InteractionLabel,
    ReviewStatus,
    Ternary,
    canonical_json,
    read_jsonl,
    validate_dataset,
)


def _required_text(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnnotationValidationError(f"{path} must be a non-empty string")
    return value.strip()


def read_decisions(path: Path) -> dict[str, dict[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AnnotationValidationError(f"invalid decisions JSON: {exc}") from None
    if not isinstance(document, dict):
        raise AnnotationValidationError("decisions document must be an object")
    if document.get("schemaVersion") != "phone-use-review-decisions-v1":
        raise AnnotationValidationError(
            "decisions schemaVersion must equal 'phone-use-review-decisions-v1'"
        )
    reviewer_id = _required_text(document.get("reviewerId"), "reviewerId")
    reviewed_at = _required_text(document.get("reviewedAt"), "reviewedAt")
    decisions = document.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        raise AnnotationValidationError("decisions must be a non-empty array")

    by_id: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(decisions, 1):
        path_prefix = f"decisions[{index}]"
        if not isinstance(raw, dict):
            raise AnnotationValidationError(f"{path_prefix} must be an object")
        annotation_id = _required_text(raw.get("annotationId"), f"{path_prefix}.annotationId")
        if annotation_id in by_id:
            raise AnnotationValidationError(f"duplicate decision: {annotation_id}")
        try:
            label = InteractionLabel(raw.get("label")).value
            confidence = Confidence(raw.get("confidence")).value
        except (TypeError, ValueError):
            raise AnnotationValidationError(
                f"{path_prefix} has an invalid label or confidence"
            ) from None
        evidence = raw.get("reviewEvidence", {})
        if not isinstance(evidence, dict):
            raise AnnotationValidationError(f"{path_prefix}.reviewEvidence must be an object")
        for key, value in evidence.items():
            if key not in {
                "phoneVisible",
                "ownedByTarget",
                "handDeviceContact",
                "gazeAtDevice",
                "phoneAtEar",
                "repetitiveManipulation",
            }:
                raise AnnotationValidationError(
                    f"{path_prefix}.reviewEvidence has unknown field: {key}"
                )
            try:
                Ternary(value)
            except (TypeError, ValueError):
                raise AnnotationValidationError(
                    f"{path_prefix}.reviewEvidence.{key} must be YES, NO or UNCERTAIN"
                ) from None
        by_id[annotation_id] = {
            "annotationId": annotation_id,
            "label": label,
            "confidence": confidence,
            "notes": str(raw.get("notes", "")).strip(),
            "reviewEvidence": evidence,
            "reviewerId": reviewer_id,
            "reviewedAt": reviewed_at,
        }
    return by_id


def apply_decisions(
    records: list[dict[str, Any]],
    decisions: dict[str, dict[str, Any]],
    *,
    require_complete: bool = False,
) -> list[dict[str, Any]]:
    queue_ids = {record["annotationId"] for record in records}
    unknown = sorted(set(decisions) - queue_ids)
    if unknown:
        raise AnnotationValidationError(
            "decisions reference unknown annotationId(s): " + ", ".join(unknown)
        )

    output: list[dict[str, Any]] = []
    for original in records:
        record = deepcopy(original)
        decision = decisions.get(record["annotationId"])
        if decision:
            record["review"].update(
                {
                    "status": ReviewStatus.LABELLED.value,
                    "label": decision["label"],
                    "reviewerId": decision["reviewerId"],
                    "reviewedAt": decision["reviewedAt"],
                    "confidence": decision["confidence"],
                    "notes": decision["notes"],
                }
            )
            record["reviewEvidence"].update(decision["reviewEvidence"])
        output.append(record)

    report = validate_dataset(output)
    if require_complete and report.pending:
        raise AnnotationValidationError(
            f"review is incomplete: {report.pending} of {report.records} records remain pending"
        )
    return output


def write_jsonl_atomic(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    )
    temporary = Path(handle.name)
    try:
        with handle:
            for record in records:
                handle.write(canonical_json(record) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge review decisions into a CCTV JSONL queue")
    parser.add_argument("queue", type=Path)
    parser.add_argument("decisions", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument(
        "--decision-prefix",
        help="Explicitly select decisions whose annotationId begins with this clip prefix",
    )
    args = parser.parse_args()

    if args.output.resolve() == args.queue.resolve():
        raise SystemExit("INVALID: --output must not overwrite the input queue")
    try:
        decisions = read_decisions(args.decisions)
        if args.decision_prefix:
            decisions = {
                annotation_id: decision
                for annotation_id, decision in decisions.items()
                if annotation_id.startswith(args.decision_prefix)
            }
            if not decisions:
                raise AnnotationValidationError(
                    f"no decisions match prefix: {args.decision_prefix}"
                )
        records = apply_decisions(
            read_jsonl(args.queue),
            decisions,
            require_complete=args.require_complete,
        )
        write_jsonl_atomic(args.output, records)
        report = validate_dataset(records)
    except AnnotationValidationError as exc:
        raise SystemExit(f"INVALID: {exc}") from None
    print(json.dumps(report.to_dict(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
