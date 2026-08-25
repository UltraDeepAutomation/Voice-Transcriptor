"""Regression tests for the word-precise emit trim in ``LiveSession``.

Both failure modes documented on ``LiveConfig.word_timestamps``
manifested to the user as duplicated phrases in the live transcript:

  * Whisper's SEGMENT timestamps drift across window boundaries between
    passes. A phrase that lies inside the re-fed ``overlap_sec`` head can
    come back with an estimated END slightly PAST the emit watermark,
    passing the ``g_end <= cutoff`` guard — the whole segment was
    re-emitted and the user saw the same clause twice.

  * The mirror image: a boundary-straddling segment whose coarse end
    lands within epsilon of the watermark was skipped wholesale,
    swallowing its genuinely new trailing words.

The fix trims by WORD timestamps: drop every word already committed,
keep exactly the new tail, anchor the event at the first new word's
onset, and fall back to the segment-end heuristic only when the model
returned no word data.
"""

import asyncio
import unittest
from unittest import mock

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.live import LiveConfig, LiveSession


def _pcm_seconds(seconds: float) -> bytes:
    return b"\x01\x00" * int(seconds * LIVE_SAMPLE_RATE_HZ)


async def _feed(session: LiveSession, seconds: float) -> None:
    frame_bytes = 2048 * 2
    payload = _pcm_seconds(seconds)
    for offset in range(0, len(payload), frame_bytes):
        await session.append_pcm16le(payload[offset:offset + frame_bytes])


def _word(text: str, start: float, end: float) -> dict:
    # faster-whisper convention: leading space on every token except
    # the first — the trim path reconstructs text by concatenation.
    prefix = "" if text == "alpha" else " "
    return {"word": f"{prefix}{text}", "start": start, "end": end}


class LiveWordTrimTests(unittest.TestCase):
    def _session(self) -> LiveSession:
        return LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(window_sec=8.0, overlap_sec=1.0, ring_slack_sec=10.0),
        )

    def test_drifted_overlap_phrase_is_not_reemitted_but_tail_words_are_kept(self):
        """The duplication bug, end to end.

        Pass 1 emits "alpha beta" ending at t=9.7 (watermark 9.7).
        Pass 2 re-decodes the [9.0, 11.5] window (offset 9.0) and the
        model returns the SAME phrase again — its coarse segment end
        drifted to 9.78, past the cutoff (9.75), so the OLD segment-end
        heuristic would re-emit it wholesale. Word timestamps must drop
        both stale words (ends 9.40 / 9.72 <= cutoff) while keeping the
        genuinely new "gamma", anchored at its own onset.
        """
        session = self._session()
        results = []

        def fake_transcribe(audio, *_args, **_kwargs):
            if not results:
                # Window covers [0, 10]; offset 0.
                seg = {"start": 2.0, "end": 9.7, "text": "alpha beta",
                       "words": [_word("alpha", 2.0, 4.9), _word("beta", 5.0, 9.7)]}
            else:
                # Second pass: window covers [9.0, 11.5] (need 2.5 s from
                # covered 10 − overlap 1). Local times below are relative
                # to 9.0. The drifted duplicate + one new word.
                seg = {"start": 0.3, "end": 2.3, "text": "alpha beta gamma",
                       "words": [
                           _word("alpha", 0.3, 0.40),   # global 9.40 <= 9.75 → drop
                           _word("beta", 0.5, 0.72),    # global 9.72 <= 9.75 → drop
                           _word("gamma", 1.4, 2.3),    # global 10.40..11.30 → keep
                       ]}
            results.append(seg)
            return {"segments": [seg]}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 10.0)
                first = await session.maybe_transcribe()
                await _feed(session, 1.5)
                second = await session.maybe_transcribe()
                return first, second

        first, second = asyncio.run(run())

        self.assertIsNotNone(first)
        assert first is not None
        self.assertEqual(first["segments"][0]["text"], "alpha beta")

        self.assertIsNotNone(second, "the new word must survive the trim")
        assert second is not None
        seg = second["segments"]
        self.assertEqual(len(seg), 1, "drifted duplicate must not be re-emitted")
        self.assertEqual(seg[0]["text"], "gamma")
        self.assertAlmostEqual(seg[0]["start"], 10.40, places=2,
                               msg="event anchors at the FIRST NEW word's onset")
        self.assertAlmostEqual(seg[0]["end"], 11.30, places=2)
        self.assertAlmostEqual(session._last_emitted_end, 11.30, places=2)

        env = session.finalize_envelope()
        self.assertEqual(env["text"], "alpha beta gamma",
                         "cumulative transcript carries each phrase exactly once")

    def test_a_word_re_heard_slightly_later_is_still_the_same_word(self):
        """The drift the END test cannot survive.

        Production, 2026-08-25: a segment covering 8.96-9.94 was followed
        by one at 9.52-10.00 carrying the same spoken numbers, re-decoded
        as digits. The text guard cannot see that — "пять" and "56789"
        share no token — so the only thing that can is the clock.

        Under the end test the re-decode survives: its end (10.00) is past
        the watermark (9.94), so the word is "new". Its CENTRE (9.76) is
        not, and a word whose middle lies inside committed audio is
        committed audio.
        """
        session = self._session()
        results = []

        def fake_transcribe(audio, *_args, **_kwargs):
            if not results:
                seg = {"start": 8.96, "end": 9.94, "text": "пять шесть",
                       "words": [
                           {"word": "пять", "start": 8.96, "end": 9.40},
                           {"word": " шесть", "start": 9.45, "end": 9.94},
                       ]}
            else:
                # Second pass, offset 9.0. The re-decode of the same audio
                # ends LATER than the watermark but is centred before it;
                # the trailing word is genuinely new.
                seg = {"start": 0.52, "end": 1.60, "text": "56789 дальше",
                       "words": [
                           {"word": "56789", "start": 0.52, "end": 1.00},   # centre 9.76 < 9.94
                           {"word": " дальше", "start": 1.05, "end": 1.60},  # centre 10.33 > 9.94
                       ]}
            results.append(seg)
            return {"segments": [seg]}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 10.0)
                first = await session.maybe_transcribe()
                await _feed(session, 1.5)
                second = await session.maybe_transcribe()
                return first, second

        first, second = asyncio.run(run())
        self.assertIsNotNone(first)
        self.assertIsNotNone(second, "the genuinely new word must survive")
        assert second is not None
        self.assertEqual(second["segments"][0]["text"], "дальше")
        self.assertNotIn("56789", session.finalize_envelope()["text"])

    def test_a_word_straddling_the_watermark_is_kept(self):
        """The mirror image: the centre rule must not eat new speech.

        A word that begins just before the watermark and runs past it is
        being spoken across the boundary, not re-heard. Its centre lands
        after the watermark, so it survives.
        """
        session = self._session()
        results = []

        def fake_transcribe(audio, *_args, **_kwargs):
            if not results:
                seg = {"start": 8.0, "end": 9.94, "text": "раз",
                       "words": [{"word": "раз", "start": 8.0, "end": 9.94}]}
            else:
                seg = {"start": 0.8, "end": 1.6, "text": "переход",
                       "words": [{"word": "переход", "start": 0.8, "end": 1.6}]}
                # global 9.80..10.60, centre 10.20 > 9.94 → kept
            results.append(seg)
            return {"segments": [seg]}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 10.0)
                await session.maybe_transcribe()
                await _feed(session, 1.5)
                return await session.maybe_transcribe()

        second = asyncio.run(run())
        self.assertIsNotNone(second, "a word spoken across the boundary is new speech")
        assert second is not None
        self.assertEqual(second["segments"][0]["text"], "переход")

    def test_segment_without_words_still_falls_back_to_end_watermark(self):
        """No word data (alignment unsupported / flag off) → the old
        segment-end heuristic applies unchanged: a re-decoded segment
        whose coarse end sits at/below the cutoff is skipped."""
        session = self._session()
        state = {"passes": 0}

        def fake_transcribe(audio, *_args, **_kwargs):
            if state["passes"] == 0:
                seg = {"start": 2.0, "end": 9.7, "text": "alpha beta", "words": []}
            else:
                # Re-decoded overlap: coarse end BELOW the cutoff even after
                # drift — nothing new here.
                seg = {"start": 0.3, "end": 0.6, "text": "alpha beta", "words": []}
            state["passes"] += 1
            return {"segments": [seg]}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 10.0)
                first = await session.maybe_transcribe()
                await _feed(session, 1.5)
                second = await session.maybe_transcribe()
                return first, second

        first, second = asyncio.run(run())
        self.assertIsNotNone(first)
        self.assertIsNone(second, "heuristic path must still suppress the duplicate")
        self.assertAlmostEqual(session._last_emitted_end, 9.70, places=2)

    def test_wordless_straddle_is_not_swallowed_when_end_crosses_cutoff(self):
        """Mirror failure on the heuristic path: a segment straddling the
        boundary (coarse end just past cutoff) IS emitted wholesale —
        which is precisely why the word-timestamp path exists. Guarded
        here so a future refactor cannot silently flip the fallback's
        comparison direction."""
        session = self._session()
        state = {"passes": 0}

        def fake_transcribe(audio, *_args, **_kwargs):
            if state["passes"] == 0:
                seg = {"start": 2.0, "end": 9.7, "text": "alpha beta", "words": []}
            else:
                seg = {"start": 0.3, "end": 0.9, "text": "tail", "words": []}
            state["passes"] += 1
            return {"segments": [seg]}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 10.0)
                await session.maybe_transcribe()
                await _feed(session, 1.5)
                return await session.maybe_transcribe()

        out = asyncio.run(run())
        self.assertIsNotNone(out, "g_end 9.9 > cutoff 9.75 must be emitted")
        assert out is not None
        self.assertEqual(out["segments"][0]["text"], "tail")


if __name__ == "__main__":
    unittest.main()
