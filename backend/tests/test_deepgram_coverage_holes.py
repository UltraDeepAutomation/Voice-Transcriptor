"""Detect words Deepgram recognised but never committed to a final.

Observed in main.log, session ending 21:25:43 (520 s of dictation):

    is_final  start=452.76 end=455.78  textLen=50
    interim   start=452.76 end=457.56  textLen=75      <- heard more
    is_final  start=460.09 end=463.86  textLen=42      <- resumed past it

Nothing ever covered 455.78-457.56. Those words are gone from the
committed transcript, and the streaming fast path cannot recover them:
it delivers committed segments plus the *current* interim, so an interim
from the middle of a recording is overwritten by the next one long
before Stop.

``_uncovered_speech_sec`` measures exactly this — and only this. An
ordinary pause produces no interims carrying text, so it must never
register, or every recording with a breath in it would be flagged.
"""

from __future__ import annotations

import unittest

from backend.remote_deepgram_live import (
    COVERAGE_GAP_MIN_SEC,
    INTERIM_SPEECH_MIN_CHARS,
    DeepgramLiveSession,
)


def _interim(start: float, end: float, text: str, words: list[tuple[str, float, float]] | None = None) -> dict:
    alt: dict = {"transcript": text}
    if words is not None:
        alt["words"] = [{"word": w, "start": a, "end": b} for w, a, b in words]
    return {
        "type": "Results",
        "is_final": False,
        "speech_final": False,
        "start": start,
        "duration": end - start,
        "channel": {"alternatives": [alt]},
    }


def _session(finals, speech_spans) -> DeepgramLiveSession:
    s = DeepgramLiveSession(api_key="k")
    s._finalized_segments = [{"start": a, "end": b} for a, b in finals]
    s._interim_speech_spans = list(speech_spans)
    return s


class UncoveredSpeechTests(unittest.TestCase):
    def test_reproduces_the_observed_hole(self):
        s = _session(
            [(449.44, 452.76), (452.76, 455.78), (460.09, 463.86)],
            [(449.44, 453.29), (452.76, 457.56), (460.09, 463.19)],
        )
        # 455.78 -> 457.56 is heard but never finalised.
        self.assertAlmostEqual(s._uncovered_speech_sec(), 1.78, places=2)

    def test_a_silent_pause_is_not_a_hole(self):
        """The 15 s gap here carries no speech — it is the user thinking."""
        s = _session([(0, 10), (25, 30)], [(0, 10), (25, 30)])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)

    def test_overlapping_interims_are_not_counted_twice(self):
        s = _session([(0, 10), (20, 30)], [(10, 15), (11, 16), (12, 18)])
        self.assertAlmostEqual(s._uncovered_speech_sec(), 8.0, places=3)

    def test_segment_boundary_jitter_is_not_a_hole(self):
        """Sub-threshold slivers between adjacent finals are boundaries."""
        tiny = COVERAGE_GAP_MIN_SEC / 2
        s = _session([(0, 10), (10 + tiny, 20)], [(0, 20)])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)

    def test_speech_after_the_last_final_counts(self):
        """Deepgram stopped finalising while its interims kept hearing."""
        s = _session([(0, 10)], [(0, 10), (10, 14)])
        self.assertAlmostEqual(s._uncovered_speech_sec(), 4.0, places=3)

    def test_noise_hypotheses_do_not_register_as_speech(self):
        """Deepgram emits 1-2 character interims during silence; those
        must not turn every pause into a reported hole."""
        s = DeepgramLiveSession(api_key="k")
        s._finalized_segments = [{"start": 0, "end": 10}, {"start": 25, "end": 30}]
        s._interim_speech_spans = []  # short interims were never recorded
        self.assertEqual(s._uncovered_speech_sec(), 0.0)
        self.assertGreater(INTERIM_SPEECH_MIN_CHARS, 2)

    def test_no_finals_or_no_speech_is_zero(self):
        self.assertEqual(_session([], [(0, 5)])._uncovered_speech_sec(), 0.0)
        self.assertEqual(_session([(0, 5)], [])._uncovered_speech_sec(), 0.0)

    def test_fully_covered_session_reports_nothing(self):
        s = _session([(0, 10), (10, 20)], [(0, 9), (10, 19)])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)


if __name__ == "__main__":
    unittest.main()


class SpeechSpanSourceTests(unittest.TestCase):
    """What counts as "the service heard words here"."""

    def test_the_re_decode_window_is_not_charged_as_speech(self):
        # A rolling interim spans five seconds and carries two words at
        # its end. Charging the window made this message report ~4 s of
        # recognised speech that was never spoken — and every such
        # message inflated the hole warning shown to the user.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(10.0, 15.0, "последнее слово", [("последнее", 14.2, 14.6), ("слово", 14.6, 15.0)])
        )
        self.assertEqual(s._interim_speech_spans, [(14.2, 15.0)])
        s._finalized_segments = [{"start": 0.0, "end": 10.0}]
        self.assertAlmostEqual(s._uncovered_speech_sec(), 0.8, places=6)

    def test_breath_between_words_is_not_a_hole(self):
        # Words closer together than the boundary threshold are one run
        # of speech; the silence between them is not measurable loss.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(0.0, 3.0, "раз два три", [("раз", 0.0, 0.4), ("два", 0.6, 1.0), ("три", 1.1, 1.5)])
        )
        self.assertEqual(s._interim_speech_spans, [(0.0, 1.5)])

    def test_a_real_pause_inside_the_window_splits_the_span(self):
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(0.0, 9.0, "начало и конец", [("начало", 0.0, 0.5), ("и", 0.6, 0.8), ("конец", 8.0, 8.6)])
        )
        self.assertEqual(s._interim_speech_spans, [(0.0, 0.8), (8.0, 8.6)])

    def test_a_hypothesis_without_word_timings_still_reports_its_span(self):
        # Fallback: no word list means the message span is all we know,
        # and going blind would be worse than over-reporting.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(_interim(4.0, 6.0, "без таймингов слов"))
        self.assertEqual(s._interim_speech_spans, [(4.0, 6.0)])

    def test_noise_hypotheses_are_still_excluded(self):
        s = DeepgramLiveSession(api_key="k")
        short = "ой"
        self.assertLess(len(short), INTERIM_SPEECH_MIN_CHARS)
        s._process_deepgram_message(_interim(1.0, 2.0, short, [("ой", 1.0, 1.2)]))
        self.assertEqual(s._interim_speech_spans, [])
