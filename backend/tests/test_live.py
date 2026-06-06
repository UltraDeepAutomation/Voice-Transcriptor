import unittest
from unittest import mock

from backend.live import LiveConfig, LiveSession


class LiveSessionTailTests(unittest.IsolatedAsyncioTestCase):
    async def test_force_transcribe_bypasses_min_step_for_stop_tail(self):
        sr = 16_000
        session = LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(
                sample_rate=sr,
                window_sec=8.0,
                min_step_sec=10.0,
                min_audio_sec=0.1,
            ),
        )
        await session.append_pcm16le(b"\x01\x00" * sr)

        calls = []

        def fake_transcribe(audio, *_args, **_kwargs):
            calls.append(audio.shape[0])
            return {
                "segments": [
                    {
                        "start": 0.0,
                        "end": audio.shape[0] / sr,
                        "text": "tail words",
                    }
                ]
            }

        with mock.patch("backend.live.transcribe_audio", side_effect=fake_transcribe):
            self.assertIsNone(await session.maybe_transcribe())

            forced = await session.maybe_transcribe(force=True)
            self.assertIsNotNone(forced)
            self.assertEqual(forced["segments"][0]["text"], "tail words")

            self.assertIsNone(await session.maybe_transcribe(force=True))

        self.assertEqual(calls, [sr])


if __name__ == "__main__":
    unittest.main()
