import copy
import hashlib
import json
import unittest
from pathlib import Path

from robustness_augmentation import build_augmented_rows, canonical_sha256, load_augmentation_spec


PIN = {
    "teacher_model": "Qwen/Qwen3-8B",
    "teacher_revision": "teacher-revision-123",
    "judge_model": "Qwen/Qwen3.5-9B",
    "judge_revision": "judge-revision-456",
    "generation_prompt_sha256": "a" * 64,
    "judge_prompt_sha256": "b" * 64,
}


def rows(split="train"):
    common = {
        "group_id": "g1",
        "split": split,
        "source": "grav-acc-routing-v2/ledger_party",
        "state": {"question": "balance of Oruvik as at 26-09-2026"},
        "options": ["acc_ledger_balance: read", "clarify: ask"],
        "metadata": {
            "question_id": "route",
            "provenance": {"generator_version": "grav-acc-routing-v2"},
            "grav": {"gold": "acc_ledger_balance", "reason": None},
        },
        "target": [1, 0],
    }
    route = {**copy.deepcopy(common), "id": "base:route:registered"}
    argument = copy.deepcopy(common)
    argument.update({
        "id": "base:arg:account",
        "metadata": {**argument["metadata"], "question_id": "account"},
        "options": ["Oruvik", "none"],
        "target": [1, 0],
    })
    return [route, argument]


def record(question="balance of Oruvik as at 26-09-2026"):
    return {
        "source_key": "base",
        "source_question_sha256": canonical_sha256(question),
        "paraphrase": "Could you please show Oruvik's balance as at 26-09-2026?",
        "judge_passed": True,
        **PIN,
    }


class RobustnessAugmentationTest(unittest.TestCase):
    def test_shipped_augmentation_spec_pins_models_and_prompt_bytes(self):
        root = Path(__file__).resolve().parent
        path = root / "configs/qwen35-9b-proxy-ood-augmentation.json"
        spec = load_augmentation_spec(path)
        self.assertEqual(spec["source_splits"], ["train", "validation"])
        self.assertEqual(spec["minimum_acceptance_rate"], 0.8)
        self.assertIs(spec["locked_rows_read"], False)
        self.assertNotEqual(
            (spec["teacher"]["model"], spec["teacher"]["revision"]),
            (spec["judge"]["model"], spec["judge"]["revision"]),
        )
        for role in ("teacher", "judge"):
            prompt = root / spec[role]["prompt"]
            self.assertEqual(hashlib.sha256(prompt.read_bytes()).hexdigest(), spec[role]["prompt_sha256"])

    def test_augmentation_spec_fails_closed_if_locked_or_prompt_changes(self):
        root = Path(__file__).resolve().parent
        original = json.loads((root / "configs/qwen35-9b-proxy-ood-augmentation.json").read_text())
        with __import__("tempfile").TemporaryDirectory() as d:
            base = Path(d) / "train"
            temp = base / "configs"
            temp.mkdir(parents=True)
            (base / "prompts").mkdir()
            for role in ("teacher", "judge"):
                source = root / original[role]["prompt"]
                target = base / original[role]["prompt"]
                target.write_bytes(source.read_bytes())
            bad = {**original, "source_splits": ["train", "ood"]}
            p = temp / "bad.json"
            p.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, "never locked"):
                load_augmentation_spec(p)

            changed = copy.deepcopy(original)
            changed["teacher"]["prompt_sha256"] = "0" * 64
            p.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, "prompt bytes"):
                load_augmentation_spec(p)

    def test_inherits_every_decision_and_changes_only_language_and_provenance(self):
        source = rows()
        out = build_augmented_rows(source, [record()], **PIN)
        self.assertEqual(len(out), 2)
        for before, after in zip(sorted(source, key=lambda r: r["id"]), sorted(out, key=lambda r: r["id"])):
            self.assertEqual(after["split"], "train")
            self.assertEqual(after["options"], before["options"])
            self.assertEqual(after["target"], before["target"])
            self.assertEqual(after["metadata"]["grav"]["gold"], before["metadata"]["grav"]["gold"])
            self.assertFalse(after["metadata"]["grav"]["proxy_ood"])
            self.assertIn("semantic-paraphrase", after["id"])

    def test_validation_paraphrases_are_marked_proxy_ood(self):
        out = build_augmented_rows(rows("validation"), [record()], **PIN)
        self.assertTrue(all(r["metadata"]["grav"]["proxy_ood"] for r in out))

    def test_output_is_deterministic_independent_of_teacher_record_order(self):
        a = record()
        b = {**record(), "paraphrase": "As at 26-09-2026, what is Oruvik's balance?"}
        left = build_augmented_rows(rows(), [a, b], **PIN)
        right = build_augmented_rows(rows(), [b, a], **PIN)
        self.assertEqual(left, right)

    def test_locked_sources_are_refused(self):
        with self.assertRaisesRegex(ValueError, "forbidden"):
            build_augmented_rows(rows("ood"), [record()], **PIN)

    def test_unpinned_or_unjudged_teacher_output_is_refused(self):
        with self.assertRaisesRegex(ValueError, "provenance"):
            build_augmented_rows(rows(), [{**record(), "teacher_revision": "other-revision"}], **PIN)
        with self.assertRaisesRegex(ValueError, "judge"):
            build_augmented_rows(rows(), [{**record(), "judge_passed": False}], **PIN)

    def test_changed_numbers_or_unchanged_language_are_refused(self):
        changed = {**record(), "paraphrase": "Show Oruvik's balance as at 25-09-2026"}
        with self.assertRaisesRegex(ValueError, "protected"):
            build_augmented_rows(rows(), [changed], **PIN)
        unchanged = {**record(), "paraphrase": "balance of Oruvik as at 26-09-2026"}
        with self.assertRaisesRegex(ValueError, "unchanged"):
            build_augmented_rows(rows(), [unchanged], **PIN)

    def test_teacher_and_judge_must_be_independent(self):
        pin = {**PIN, "judge_model": PIN["teacher_model"], "judge_revision": PIN["teacher_revision"]}
        with self.assertRaisesRegex(ValueError, "independently"):
            build_augmented_rows(rows(), [{**record(), **pin}], **pin)

    def test_teacher_cannot_supply_decision_fields(self):
        for field in ("gold", "label", "options", "reason", "route", "target"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "language only"):
                build_augmented_rows(rows(), [{**record(), field: "invented"}], **PIN)


if __name__ == "__main__":
    unittest.main()
