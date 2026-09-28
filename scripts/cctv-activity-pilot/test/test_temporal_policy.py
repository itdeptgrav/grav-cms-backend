import json
import unittest
from pathlib import Path

from scripts.cctv_activity_pilot.temporal_policy import LABELS, TemporalPolicy


class TemporalPolicyTest(unittest.TestCase):
    def test_incomplete_four_second_window_stays_uncertain(self):
        policy = TemporalPolicy()
        result = policy.observe(6, "talking_or_interacting", window_complete=False)
        self.assertEqual(result.emitted_label, "uncertain")
        self.assertEqual(result.decision_status, "warming_up")

    def test_one_talking_guess_does_not_override_no_task(self):
        policy = TemporalPolicy(confirmations=2)
        policy.observe(6, "no_observable_task", window_complete=True)
        confirmed = policy.observe(6, "no_observable_task", window_complete=True)
        self.assertEqual(confirmed.emitted_label, "no_observable_task")

        isolated = policy.observe(6, "talking_or_interacting", window_complete=True)
        self.assertEqual(isolated.emitted_label, "no_observable_task")
        self.assertEqual(isolated.decision_status, "candidate")

    def test_phone_requires_two_consistent_windows(self):
        policy = TemporalPolicy(confirmations=2)
        first = policy.observe(5, "using_phone", window_complete=True)
        second = policy.observe(5, "using_phone", window_complete=True)
        self.assertEqual(first.emitted_label, "uncertain")
        self.assertEqual(second.emitted_label, "using_phone")

    def test_short_uncertainty_does_not_erase_confirmed_activity(self):
        policy = TemporalPolicy(confirmations=2, uncertain_hold=2)
        policy.observe(1, "working", window_complete=True)
        policy.observe(1, "working", window_complete=True)
        held = policy.observe(1, "uncertain", window_complete=True)
        self.assertEqual(held.emitted_label, "working")
        self.assertEqual(held.decision_status, "held_during_uncertainty")

    def test_unknown_label_fails_closed(self):
        policy = TemporalPolicy()
        with self.assertRaises(ValueError):
            policy.observe(1, "gossiping", window_complete=True)


class CorrectionFixtureTest(unittest.TestCase):
    def test_correction_fixture_uses_only_contract_labels(self):
        path = Path(__file__).parents[1] / "corrections.v1.json"
        fixture = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(fixture["corrections"]), 5)
        for correction in fixture["corrections"]:
            self.assertTrue(correction["allowed_labels"])
            self.assertTrue(set(correction["allowed_labels"]).issubset(LABELS))
        self.assertEqual(len(fixture["first_four_second_window_expectations"]), 3)
        for expectation in fixture["first_four_second_window_expectations"]:
            self.assertEqual(expectation["samples"], [1, 2, 3, 4])
            self.assertTrue(set(expectation["allowed_labels"]).issubset(LABELS))


if __name__ == "__main__":
    unittest.main()
