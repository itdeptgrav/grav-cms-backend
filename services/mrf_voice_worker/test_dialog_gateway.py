import unittest

from dialog_routes import route_for_output


class DialogueRouteTests(unittest.TestCase):
    def test_decision_codes_never_commit_directly(self):
        self.assertEqual(route_for_output("A")[:2], ("APPROVE", "CONFIRM_APPROVE"))
        self.assertEqual(route_for_output("R")[:2], ("REJECT", "CONFIRM_REJECT"))
        self.assertEqual(route_for_output("D")[:2], ("DEFER", "CONFIRM_DEFER"))

    def test_question_and_conversation_codes_are_bounded(self):
        self.assertEqual(route_for_output("W")[:2], ("UNKNOWN", "WHO_REQUESTED"))
        self.assertEqual(route_for_output("I")[:2], ("UNKNOWN", "ITEMS"))
        self.assertEqual(route_for_output("H")[:2], ("UNKNOWN", "ACKNOWLEDGE"))

    def test_unusable_output_fails_to_safe_refocus(self):
        self.assertEqual(route_for_output("I would answer with a paragraph")[:2], ("UNKNOWN", "REFOCUS"))
        self.assertEqual(route_for_output("")[:2], ("UNKNOWN", "REFOCUS"))


if __name__ == "__main__":
    unittest.main()
