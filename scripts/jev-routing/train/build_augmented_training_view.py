"""Build a manifest-bound Jev training view from independently judged paraphrases.

This command performs no model inference. It accepts only the closed,
immutable augmentation spec and stored language-only teacher/judge records,
then copies all decision fields from the pinned source view. The resulting
directory still contains exactly train, calibration, validation and manifest;
locked rows are neither accepted nor produced.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from grav_jev_train import file_sha256, guard_training_view, read_split
from robustness_augmentation import build_augmented_rows, load_augmentation_spec


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows))


def build_view(*, source_dir, records_path, spec_path, output_dir) -> dict:
    source = Path(source_dir).resolve()
    records_file = Path(records_path).resolve()
    output = Path(output_dir).resolve()
    spec = load_augmentation_spec(spec_path)
    source_manifest = guard_training_view(source, spec["source_train_view_manifest_sha256"])
    if output.exists() and any(output.iterdir()):
        raise ValueError("output directory must be absent or empty")
    output.mkdir(parents=True, exist_ok=True)

    train = read_split(source, "train")
    calibration = read_split(source, "calibration")
    validation = read_split(source, "validation")
    records = read_jsonl(records_file)
    pins = {
        "teacher_model": spec["teacher"]["model"],
        "teacher_revision": spec["teacher"]["revision"],
        "judge_model": spec["judge"]["model"],
        "judge_revision": spec["judge"]["revision"],
        "generation_prompt_sha256": spec["teacher"]["prompt_sha256"],
        "judge_prompt_sha256": spec["judge"]["prompt_sha256"],
    }
    augmented = build_augmented_rows(train + validation, records, **pins)
    augmented_train = [row for row in augmented if row["split"] == "train"]
    augmented_validation = [row for row in augmented if row["split"] == "validation"]
    outputs = {
        "train.jsonl": sorted(train + augmented_train, key=lambda row: row["id"]),
        "calibration.jsonl": sorted(calibration, key=lambda row: row["id"]),
        "validation.jsonl": sorted(validation + augmented_validation, key=lambda row: row["id"]),
    }
    for name, rows in outputs.items():
        write_jsonl(output / name, rows)
    manifest = {
        "generator_version": source_manifest["generator_version"],
        "files_sha256": {name: file_sha256(output / name) for name in sorted(outputs)},
        "augmentation": {
            "schema": spec["schema"],
            "spec_sha256": file_sha256(spec_path),
            "records_sha256": file_sha256(records_file),
            "source_train_view_manifest_sha256": spec["source_train_view_manifest_sha256"],
            "accepted_utterances": len(records),
            "augmented_rows": len(augmented),
            "locked_rows_read": False,
            "validation_role": spec["validation_role"],
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    manifest_sha = file_sha256(output / "manifest.json")
    guard_training_view(output, manifest_sha)
    return {"manifest_sha256": manifest_sha, **manifest["augmentation"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--records", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    print(json.dumps(build_view(
        source_dir=args.source,
        records_path=args.records,
        spec_path=args.spec,
        output_dir=args.output,
    ), sort_keys=True))


if __name__ == "__main__":
    main()

