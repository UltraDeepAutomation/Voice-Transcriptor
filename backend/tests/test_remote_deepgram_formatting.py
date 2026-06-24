import unittest
from unittest import mock

from backend.remote_deepgram import (
    DeepgramRemoteError,
    _deepgram_http_policy,
    _format_deepgram_speaker_words,
    deepgram_transcribe,
)


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

    def test_num_speakers_is_sent_when_diarization_is_enabled(self):
        class FakeResponse:
            status_code = 200

            def json(self):
                return {
                    "results": {
                        "channels": [
                            {"alternatives": [{"transcript": "ok", "words": []}]}
                        ]
                    }
                }

        calls = []

        def fake_request(*args, **kwargs):
            calls.append((args, kwargs))
            return FakeResponse()

        with mock.patch("backend.remote_deepgram.request_with_retry", side_effect=fake_request):
            deepgram_transcribe(
                api_key="dg",
                audio_bytes=b"wav",
                filename="audio.wav",
                diarize=True,
                num_speakers="2",
            )

        self.assertEqual(calls[0][1]["params"]["diarize"], "true")
        self.assertEqual(calls[0][1]["params"]["num_speakers"], "2")

    def test_invalid_num_speakers_fails_before_provider_request(self):
        with mock.patch("backend.remote_deepgram.request_with_retry") as request:
            with self.assertRaises(DeepgramRemoteError):
                deepgram_transcribe(
                    api_key="dg",
                    audio_bytes=b"wav",
                    filename="audio.wav",
                    diarize=True,
                    num_speakers="many",
                )
        request.assert_not_called()

    def test_small_live_recovery_payload_fails_fast(self):
        self.assertEqual(_deepgram_http_policy(40_379), ((10, 12), 1))

    def test_large_upload_preserves_long_upload_budget(self):
        self.assertEqual(_deepgram_http_policy(26 * 1024 * 1024), ((10, 208), 2))


if __name__ == "__main__":
    unittest.main()
