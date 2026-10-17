import unittest

from speech_text import (
    feminine_hindi_agent_voice,
    is_hearing_acknowledgement,
    is_negative_hearing_response,
    pronounce_initialisms,
    spell_residual_latin,
)


class SpeechTextTest(unittest.TestCase):
    def test_mrf_has_explicit_letter_pauses_in_hindi(self):
        rendered = pronounce_initialisms("GRAV MRF-204 CMS", "hi")
        self.assertEqual(rendered, "ग्रैव एम, आर, एफ-204 सी, एम, एस")

    def test_qwen_transliterated_mrf_also_gets_pauses(self):
        rendered = pronounce_initialisms("एम आर एफ दो सौ चार", "hi")
        self.assertEqual(rendered, "एम, आर, एफ दो सौ चार")

    def test_mrf_has_explicit_letter_pauses_in_odia(self):
        rendered = pronounce_initialisms("MRF-204", "or")
        self.assertEqual(rendered, "ଏମ୍, ଆର୍, ଏଫ୍-204")

    def test_feminine_assistant_grammar_is_enforced(self):
        rendered = feminine_hindi_agent_voice("मैं कॉल कर रहा हूँ और मदद कर सकता हूँ। मैं समझ गया।")
        self.assertEqual(rendered, "मैं कॉल कर रही हूँ और मदद कर सकती हूँ। मैं समझ गई।")

    def test_romanized_hindi_hearing_confirmation_skips_qwen(self):
        self.assertTrue(is_hearing_acknowledgement("Ji main aap ko sun pa raha hoon"))

    def test_stt_je_variant_skips_qwen(self):
        self.assertTrue(is_hearing_acknowledgement("Je"))

    def test_negative_hearing_response_does_not_skip_qwen(self):
        self.assertFalse(is_hearing_acknowledgement("Nahi, main aapko sun nahi pa raha hoon"))

    def test_only_explicit_cannot_hear_response_repeats_greeting(self):
        self.assertTrue(is_negative_hearing_response("Nahi, sunai nahi de raha"))
        self.assertFalse(is_negative_hearing_response("Mwnse"))

    def test_residual_latin_can_never_silence_hindi_tts(self):
        rendered = spell_residual_latin("नाम Anita और SKU", "hi")
        self.assertNotRegex(rendered, r"[A-Za-z]")
        self.assertIn("ए, एन, आई, टी, ए", rendered)

    def test_residual_latin_can_never_silence_odia_tts(self):
        rendered = spell_residual_latin("ନାମ Anita", "or")
        self.assertNotRegex(rendered, r"[A-Za-z]")


if __name__ == "__main__":
    unittest.main()
