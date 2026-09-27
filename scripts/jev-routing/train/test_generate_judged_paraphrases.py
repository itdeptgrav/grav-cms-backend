import copy
import unittest

from generate_judged_paraphrases import generate_records, source_utterances


def row(row_id, split, question):
    return {
        "id": row_id, "split": split, "state": {"question": question},
        "options": ["secret tool"], "target": [1],
        "metadata": {"question_id": "route", "grav": {"gold": "secret-route", "reason": "secret"}},
    }


SPEC = {
    "minimum_acceptance_rate": 0.5,
    "teacher": {"model": "teacher", "revision": "1" * 40, "prompt_sha256": "a" * 64},
    "judge": {"model": "judge", "revision": "2" * 40, "prompt_sha256": "b" * 64},
}


class GenerateJudgedParaphrasesTest(unittest.TestCase):
    def test_models_receive_language_only_and_output_has_no_decisions(self):
        utterances = source_utterances([
            row("x:route:a", "train", "balance of Oruvik"),
            row("x:arg:a", "train", "balance of Oruvik"),
        ])
        seen = []
        def teacher(payload):
            seen.append(("teacher", copy.deepcopy(payload)))
            return '{"paraphrase":"Please show Oruvik balance"}'
        def judge(payload):
            seen.append(("judge", copy.deepcopy(payload)))
            return '{"equivalent":true,"reason":"same request"}'
        accepted, rejected, _ = generate_records(utterances, SPEC, teacher, judge)
        self.assertEqual(rejected, [])
        self.assertEqual(len(accepted), 1)
        self.assertEqual(set(seen[0][1]), {"source_question"})
        self.assertEqual(set(seen[1][1]), {"source_question", "proposed_paraphrase"})
        for forbidden in ("gold", "target", "options", "route", "reason"):
            self.assertNotIn(forbidden, accepted[0])

    def test_changed_facts_and_low_acceptance_fail_closed(self):
        utterances = source_utterances([
            row("x:route:a", "validation", "balance as at 26-09-2026"),
            row("y:route:a", "validation", "balance as at 27-09-2026"),
        ])
        teacher = lambda payload: '{"paraphrase":"balance as at 25-09-2026"}'
        judge = lambda payload: '{"equivalent":true,"reason":"same"}'
        with self.assertRaisesRegex(ValueError, "below pinned minimum"):
            generate_records(utterances, SPEC, teacher, judge)

    def test_judge_rejection_is_not_accepted(self):
        utterances = source_utterances([row("x:route:a", "train", "balance of Oruvik")])
        teacher = lambda payload: '{"paraphrase":"Please show Oruvik balance"}'
        judge = lambda payload: '{"equivalent":false,"reason":"not equivalent"}'
        with self.assertRaisesRegex(ValueError, "below pinned minimum"):
            generate_records(utterances, SPEC, teacher, judge)


if __name__ == "__main__":
    unittest.main()

