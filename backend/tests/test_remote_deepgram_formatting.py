import unittest

from backend.remote_deepgram import _format_deepgram_speaker_words


class DeepgramFormattingTests(unittest.TestCase):
    def test_diarized_words_render_speaker_labels(self):
        text = _format_deepgram_speaker_words([
            {"speaker": 0, "punctuated_word": "Hello"},
            {"speaker": 0, "punctuated_word": "there."},
            {"speaker": 1, "punctuated_word": "Hi"},
            {"speaker": 1, "punctuated_word": "back."},
        ])

        self.assertEqual(text, "Speaker 0: Hello there.\n\nSpeaker 1: Hi back.")

    def test_words_without_speaker_do_not_replace_flat_transcript(self):
        self.assertEqual(
            _format_deepgram_speaker_words([
                {"punctuated_word": "Plain"},
                {"punctuated_word": "text."},
            ]),
            "",
        )


if __name__ == "__main__":
    unittest.main()
