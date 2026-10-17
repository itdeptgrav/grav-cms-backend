#!/usr/bin/env python3
"""Build blinded second-review queues and compare independent reviews."""

from __future__ import annotations

import argparse
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from scripts.cctv_phone_use_pilot.annotation_schema import (
    AnnotationValidationError,
    ReviewStatus,
    Ternary,
    read_jsonl,
    validate_dataset,
)
from scripts.cctv_phone_use_pilot.apply_reviews import write_jsonl_atomic


ACTIVE_LABELS = {
    "ACTIVE_VIEW_OR_TYPE",
    "ACTIVE_CALL",
    "ACTIVE_USE_UNSPECIFIED",
}


def build_blinded_queue(records: list[dict[str, Any]], *, round_number: int = 2) -> list[dict[str, Any]]:
    if round_number < 2:
        raise AnnotationValidationError("adjudication round must be at least 2")
    report = validate_dataset(records)
    if report.pending:
        raise AnnotationValidationError("source review must be complete before blinding")

    blinded: list[dict[str, Any]] = []
    for original in records:
        record = deepcopy(original)
        record["review"] = {
            "status": ReviewStatus.PENDING.value,
            "label": None,
            "reviewerId": None,
            "reviewedAt": None,
            "confidence": None,
            "notes": "",
        }
        record["reviewEvidence"] = {
            key: Ternary.UNCERTAIN.value for key in record["reviewEvidence"]
        }
        record["modelSuggestion"] = None
        record["reviewRound"] = {
            "round": round_number,
            "blinded": True,
            "sourceDatasetSha256": report.dataset_sha256,
        }
        blinded.append(record)
    validate_dataset(blinded)
    return blinded


def compare_reviews(
    first: list[dict[str, Any]], second: list[dict[str, Any]]
) -> dict[str, Any]:
    first_report = validate_dataset(first)
    second_report = validate_dataset(second)
    if first_report.pending or second_report.pending:
        raise AnnotationValidationError("both reviews must be complete before comparison")

    first_by_id = {record["annotationId"]: record for record in first}
    second_by_id = {record["annotationId"]: record for record in second}
    if set(first_by_id) != set(second_by_id):
        missing_first = sorted(set(second_by_id) - set(first_by_id))
        missing_second = sorted(set(first_by_id) - set(second_by_id))
        raise AnnotationValidationError(
            f"review ID sets differ; missingFirst={missing_first}, missingSecond={missing_second}"
        )

    reviewer_pairs: set[tuple[str, str]] = set()
    exact_agreements = 0
    active_agreements = 0
    disagreements: list[dict[str, Any]] = []
    pair_counts: dict[str, int] = {}
    for annotation_id in sorted(first_by_id):
        left = first_by_id[annotation_id]
        right = second_by_id[annotation_id]
        for field in ("source", "target", "window", "split"):
            if left[field] != right[field]:
                raise AnnotationValidationError(
                    f"immutable field {field} differs for {annotation_id}"
                )
        reviewer_pair = (left["review"]["reviewerId"], right["review"]["reviewerId"])
        reviewer_pairs.add(reviewer_pair)
        if reviewer_pair[0] == reviewer_pair[1]:
            raise AnnotationValidationError(
                f"independent review requires different reviewerId values: {annotation_id}"
            )

        first_label = left["review"]["label"]
        second_label = right["review"]["label"]
        pair_key = f"{first_label} -> {second_label}"
        pair_counts[pair_key] = pair_counts.get(pair_key, 0) + 1
        exact = first_label == second_label
        active_match = (first_label in ACTIVE_LABELS) == (second_label in ACTIVE_LABELS)
        exact_agreements += int(exact)
        active_agreements += int(active_match)
        if not exact:
            disagreements.append(
                {
                    "annotationId": annotation_id,
                    "firstLabel": first_label,
                    "secondLabel": second_label,
                    "firstConfidence": left["review"]["confidence"],
                    "secondConfidence": right["review"]["confidence"],
                    "activeUseDisagreement": not active_match,
                }
            )

    count = len(first_by_id)
    return {
        "schemaVersion": "phone-use-review-comparison-v1",
        "records": count,
        "reviewerPairs": [list(pair) for pair in sorted(reviewer_pairs)],
        "exactAgreement": exact_agreements,
        "exactAgreementRate": round(exact_agreements / count, 6),
        "activeBinaryAgreement": active_agreements,
        "activeBinaryAgreementRate": round(active_agreements / count, 6),
        "disagreementCount": len(disagreements),
        "requiresAdjudication": bool(disagreements),
        "labelPairs": dict(sorted(pair_counts.items())),
        "disagreements": disagreements,
        "firstDatasetSha256": first_report.dataset_sha256,
        "secondDatasetSha256": second_report.dataset_sha256,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    blind = subparsers.add_parser("blind", help="create a label- and suggestion-blinded queue")
    blind.add_argument("dataset", type=Path)
    blind.add_argument("--output", type=Path, required=True)
    blind.add_argument("--round", type=int, default=2)

    compare = subparsers.add_parser("compare", help="compare two complete independent reviews")
    compare.add_argument("first", type=Path)
    compare.add_argument("second", type=Path)
    compare.add_argument("--output", type=Path)

    args = parser.parse_args()
    try:
        if args.command == "blind":
            if args.output.resolve() == args.dataset.resolve():
                raise AnnotationValidationError("--output must not overwrite the source review")
            records = build_blinded_queue(read_jsonl(args.dataset), round_number=args.round)
            write_jsonl_atomic(args.output, records)
            result = validate_dataset(records).to_dict()
        else:
            result = compare_reviews(read_jsonl(args.first), read_jsonl(args.second))
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except AnnotationValidationError as exc:
        raise SystemExit(f"INVALID: {exc}") from None
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
