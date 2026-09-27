import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import build_augmented_training_view as builder
import grav_jev_train as trainer
from robustness_augmentation import canonical_sha256


class BuildAugmentedTrainingViewTest(unittest.TestCase):
    def test_builds_closed_manifest_bound_view_without_locked_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "source"
            source.mkdir()
            common = {
                "group_id": "g", "source": "generator", "state": {"question": "balance of Oruvik"},
                "options": ["acc_ledger_balance: read", "clarify: ask"], "target": [1, 0],
                "metadata": {"question_id": "route", "grav": {"gold": "acc_ledger_balance"}},
            }
            train = {**copy.deepcopy(common), "id": "train-q:route:x", "split": "train"}
            validation = {**copy.deepcopy(common), "id": "val-q:route:x", "split": "validation"}
            calibration = {**copy.deepcopy(common), "id": "cal-q:route:x", "split": "calibration"}
            calibration["state"]["question"] = "show Oruvik balance"
            for name, rows in (("train", [train]), ("calibration", [calibration]), ("validation", [validation])):
                builder.write_jsonl(source / f"{name}.jsonl", rows)
            source_manifest = {
                "generator_version": "grav-acc-routing-v2",
                "files_sha256": {f"{name}.jsonl": trainer.file_sha256(source / f"{name}.jsonl") for name in ("train", "calibration", "validation")},
            }
            (source / "manifest.json").write_text(json.dumps(source_manifest))
            source_sha = trainer.file_sha256(source / "manifest.json")

            prompts = root / "prompts"
            configs = root / "configs"
            prompts.mkdir()
            configs.mkdir()
            (prompts / "teacher.txt").write_text("teacher")
            (prompts / "judge.txt").write_text("judge")
            prompt_sha = lambda name: hashlib.sha256((prompts / name).read_bytes()).hexdigest()
            spec = {
                "schema": "grav.jev.semantic-augmentation/1", "seed": 1,
                "source_train_view_manifest_sha256": source_sha,
                "source_splits": ["train", "validation"],
                "minimum_acceptance_rate": 0.8,
                "teacher": {"model": "teacher/model", "revision": "1" * 40, "prompt": "prompts/teacher.txt", "prompt_sha256": prompt_sha("teacher.txt"), "do_sample": False, "max_new_tokens": 16},
                "judge": {"model": "judge/model", "revision": "2" * 40, "prompt": "prompts/judge.txt", "prompt_sha256": prompt_sha("judge.txt"), "do_sample": False, "max_new_tokens": 16},
                "validation_role": "proxy_ood_only", "locked_rows_read": False,
            }
            spec_path = configs / "spec.json"
            spec_path.write_text(json.dumps(spec))
            pins = {
                "teacher_model": spec["teacher"]["model"], "teacher_revision": spec["teacher"]["revision"],
                "judge_model": spec["judge"]["model"], "judge_revision": spec["judge"]["revision"],
                "generation_prompt_sha256": spec["teacher"]["prompt_sha256"], "judge_prompt_sha256": spec["judge"]["prompt_sha256"],
            }
            records = []
            for key, paraphrase in (("train-q", "Please show Oruvik's balance"), ("val-q", "What is Oruvik's balance?")):
                records.append({"source_key": key, "source_question_sha256": canonical_sha256("balance of Oruvik"), "paraphrase": paraphrase, "judge_passed": True, **pins})
            records_path = root / "records.jsonl"
            builder.write_jsonl(records_path, records)
            output = root / "output"
            result = builder.build_view(source_dir=source, records_path=records_path, spec_path=spec_path, output_dir=output)
            self.assertFalse((output / "test.jsonl").exists())
            self.assertFalse((output / "ood.jsonl").exists())
            self.assertEqual(result["accepted_utterances"], 2)
            self.assertEqual(len(builder.read_jsonl(output / "train.jsonl")), 2)
            validation_rows = builder.read_jsonl(output / "validation.jsonl")
            self.assertEqual(len(validation_rows), 2)
            self.assertEqual(sum(bool(r["metadata"]["grav"].get("proxy_ood")) for r in validation_rows), 1)
            trainer.guard_training_view(output, result["manifest_sha256"])


if __name__ == "__main__":
    unittest.main()
