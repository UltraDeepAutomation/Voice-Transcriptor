import unittest
from unittest import mock

from backend.remote_openrouter import OpenRouterError, openrouter_transcribe, openrouter_upscale_text


class OpenRouterJsonTests(unittest.TestCase):
    def test_transcribe_invalid_json_raises_provider_error(self):
        class FakeResponse:
            status_code = 200
            text = "<html>not json</html>"

            def json(self):
                raise ValueError("not json")

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=FakeResponse()):
            with self.assertRaises(OpenRouterError) as raised:
                openrouter_transcribe(
                    api_key="sk-or-test",
                    model="google/gemini-2.5-flash",
                    audio_bytes=b"wav",
                    filename="audio.wav",
                )

        self.assertIn("invalid JSON response", str(raised.exception))

    def test_transcribe_short_audio_uses_interactive_timeout_and_canonical_mime(self):
        class FakeResponse:
            status_code = 200
            text = '{"choices":[{"message":{"content":"hello"}}]}'

            def json(self):
                return {"choices": [{"message": {"content": "hello"}}]}

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=FakeResponse()) as req:
            out = openrouter_transcribe(
                api_key="sk-or-test",
                model="google/gemini-2.5-flash",
                audio_bytes=b"opus",
                filename="clip.opus",
            )

        self.assertEqual(out["text"], "hello")
        kwargs = req.call_args.kwargs
        self.assertEqual(kwargs["timeout"], (10, 45))
        self.assertEqual(kwargs["retries"], 2)
        audio_part = kwargs["json"]["messages"][0]["content"][1]
        self.assertEqual(audio_part["input_audio"]["format"], "opus")

    def test_upscale_invalid_json_raises_provider_error(self):
        class FakeResponse:
            status_code = 200
            text = "<html>not json</html>"

            def json(self):
                raise ValueError("not json")

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=FakeResponse()):
            with self.assertRaises(OpenRouterError) as raised:
                openrouter_upscale_text(
                    api_key="sk-or-test",
                    model="google/gemini-2.5-flash",
                    text="hello",
                    instruction="clean",
                )

        self.assertIn("invalid JSON response", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
