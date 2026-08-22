"""Regression: unfinalised interim words are spliced into the transcript at finalize.

Root cause addressed: Deepgram regularly emits an interim spanning audio
that no later ``is_final`` ever lands on (logged as ``uncoveredSpeechSec``
in the user's main.log). The interim text was recognised by Deepgram but
discarded — nothing in the pipeline used it. This test pins the new
behaviour: ``_splice_uncovered_interim_words()`` promotes those retained
words into finalized segments so the hole closes at the source, with no
extra network calls.

The duplicate-safety guarantees are also tested explicitly because the
fallback path must never double a word or merge across large silences.
"""

from __future__ import annotations

import unittest

from backend.remote_deepgram_live import (
    INTERIM_WORD_GAP_SPLIT_SEC,
    DeepgramLiveSession,
)


def _session_with_words(finals, interim_words) -> DeepgramLiveSession:
    s = DeepgramLiveSession(api_key="k")
    s._finalized_segments = [
        {"start": a, "end": b, "text": f"final-{i}", "is_final": True}
        for i, (a, b) in enumerate(finals)
    ]
    s._interim_words = [
        {"word": word, "start": w_start, "end": w_end}
        for word, w_start, w_end in interim_words
    ]
    return s


class InterimSpliceTests(unittest.TestCase):
    def test_interim_words_inside_hole_are_spliced(self):
        """Reproduces the 21:25:43 hole: Deepgram heard [455.78, 457.56]
        but no final ever landed there. The retained interim words for
        that span must be promoted into a finalized segment so the
        committed transcript contains them."""
        s = _session_with_words(
            finals=[(449.44, 452.76), (452.76, 455.78), (460.09, 463.86)],
            interim_words=[
                ("el", 455.78, 455.88),
                ("último", 455.88, 456.20),
                ("tren", 456.20, 456.60),
                ("se", 456.60, 456.80),
                ("fue", 456.80, 457.10),
                ("hoy", 457.10, 457.56),
            ],
        )
        n = s._splice_uncovered_interim_words()
        self.assertEqual(n, 6)
        starts = [seg["start"] for seg in s._finalized_segments]
        # The promoted segment slots in between the surrounding finals.
        self.assertEqual(starts, [449.44, 452.76, 455.78, 460.09])
        promoted = s._finalized_segments[2]
        self.assertAlmostEqual(promoted["start"], 455.78, places=2)
        self.assertAlmostEqual(promoted["end"], 457.56, places=2)
        self.assertIn("el", promoted["text"])
        self.assertIn("hoy", promoted["text"])
        self.assertEqual(promoted["source"], "interim-fallback")

    def test_interim_words_covered_by_finals_are_not_duplicated(self):
        """Center-in-span guard: a word whose center lies inside a
        final must NOT be re-emitted as fallback. This is the guarantee
        that prevents the splice from turning into a duplicate source."""
        s = _session_with_words(
            finals=[(0.0, 10.0), (10.0, 20.0)],
            interim_words=[
                ("inside", 5.0, 5.5),    # center 5.25 → inside [0, 10] → drop
                ("edge", 9.7, 10.3),      # center 10.0 → inside [0, 10] or [10, 20] → drop
                ("middle", 15.0, 15.5),   # center 15.25 → inside [10, 20] → drop
            ],
        )
        n = s._splice_uncovered_interim_words()
        self.assertEqual(n, 0)
        self.assertEqual(len(s._finalized_segments), 2)

    def test_large_silence_between_words_splits_segments(self):
        """Two covered-against-anything words separated by silence
        longer than INTERIM_WORD_GAP_SPLIT_SEC become two distinct
        fallback segments, not one run-on sentence."""
        gap = INTERIM_WORD_GAP_SPLIT_SEC + 0.1
        # First uncovered pair [5.5..6.5]; second uncovered pair starts
        # at 6.5 + gap (=7.6) so the second final must begin AFTER
        # 7.6 + word_duration to leave them uncovered.
        s = _session_with_words(
            finals=[(0.0, 5.0), (9.0, 20.0)],
            interim_words=[
                ("primera", 5.5, 6.0),
                ("frase", 6.0, 6.5),
                ("segunda", 6.5 + gap, 6.5 + gap + 0.5),
                ("parte", 6.5 + gap + 0.5, 6.5 + gap + 1.0),
            ],
        )
        s._splice_uncovered_interim_words()
        # Expect: final(0,5) + fallback(primera frase) + fallback(segunda parte) + final(9,20)
        starts = [seg["start"] for seg in s._finalized_segments]
        self.assertEqual(starts, [0.0, 5.5, 6.5 + gap, 9.0])
        sources = [seg.get("source", "final") for seg in s._finalized_segments]
        self.assertEqual(sources, ["final", "interim-fallback", "interim-fallback", "final"])

    def test_no_words_returns_zero_and_leaves_state_unchanged(self):
        s = _session_with_words(finals=[(0, 10)], interim_words=[])
        original = list(s._finalized_segments)
        self.assertEqual(s._splice_uncovered_interim_words(), 0)
        self.assertEqual(s._finalized_segments, original)

    def test_all_interim_words_already_covered_returns_zero(self):
        """If every retained interim word is covered by finals, the
        splice must do nothing — it never invents words."""
        s = _session_with_words(
            finals=[(0, 5), (5, 10)],
            interim_words=[
                ("uno", 1.0, 1.5),
                ("dos", 2.0, 2.5),
                ("tres", 6.0, 6.5),
                ("cuatro", 7.0, 7.5),
            ],
        )
        self.assertEqual(s._splice_uncovered_interim_words(), 0)
        self.assertEqual(len(s._finalized_segments), 2)

    def test_uncovered_speech_sec_drops_to_zero_after_splice(self):
        """The whole point of the splice: holes measured by
        _uncovered_speech_sec disappear once the interim text fills
        them. Before the splice, the session reports a hole; after,
        it doesn't."""
        finals = [(449.44, 452.76), (452.76, 455.78), (460.09, 463.86)]
        interim_words = [
            ("el", 455.78, 455.88),
            ("último", 455.88, 456.20),
            ("tren", 456.20, 456.60),
        ]
        s = _session_with_words(finals=finals, interim_words=interim_words)
        # Interim span must also be recorded so _uncovered_speech_sec
        # measures the hole accurately.
        s._interim_speech_spans = [(449.44, 456.60)]
        self.assertGreater(s._uncovered_speech_sec(), 0.0)
        s._splice_uncovered_interim_words()
        self.assertEqual(s._uncovered_speech_sec(), 0.0)


if __name__ == "__main__":
    unittest.main()
